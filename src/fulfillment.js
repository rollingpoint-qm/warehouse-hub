'use strict';
/**
 * Outbound fulfilment: allocate -> pick (scan-verified) -> pack (cartons, SSCC-18) -> ship (BOL, tracking).
 *
 * Inventory moves exactly like a WMS:
 *   allocate : reserves stock in pickable bins (qty_allocated)             - nothing physically moves
 *   pick     : bin -> outbound staging (reservation moves with the goods)  - bin count drops now
 *   pack     : items assigned to cartons                                   - no stock change
 *   ship     : staging stock leaves the building (on-hand and reserved fall together)
 */
const express = require('express');
const { tx, nextCounter, audit, bad, notFound, conflict } = require('./db');
const { allow } = require('./auth');
const S = require('./stock');

const blank = (x) => x === null || x === undefined || String(x).trim() === '';
const GS1_PREFIX = process.env.GS1_COMPANY_PREFIX || '0614141';   // GS1 example prefix - replace with your licensed prefix

function ssccCheckDigit(d17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(d17[16 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
function makeSscc(serial) {
  const serialLen = 16 - GS1_PREFIX.length;
  const body = '0' + GS1_PREFIX + String(serial).padStart(serialLen, '0');       // extension digit 0 + prefix + serial = 17
  if (body.length !== 17) throw new Error('SSCC serial overflow');
  const cd = ssccCheckDigit(body);
  return { sscc: body + cd, formatted: `(00) 0 ${GS1_PREFIX} ${String(serial).padStart(serialLen, '0')} ${cd}` };
}

function fulfillmentRouter(db, hooks) {
  const r = express.Router();
  const whse = allow('WAREHOUSE');

  const order = (id) => { const o = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id); if (!o) throw notFound('Order'); return o; };
  const yr = () => new Date().getFullYear();
  const stagingFor = (siteId) => {
    const l = db.prepare("SELECT * FROM locations WHERE site_id = ? AND loc_type = 'STAGING' ORDER BY id LIMIT 1").get(siteId);
    if (!l) throw conflict('Warehouse has no outbound staging location');
    return l;
  };
  const matchesItem = (scan, sku) => {
    const s = String(scan || '').trim().toUpperCase();
    return s !== '' && (s === sku.sku || (sku.barcode && s === String(sku.barcode).toUpperCase()));
  };

  function recomputeStatus(orderId) {
    const o = order(orderId);
    if (o.status === 'CANCELLED') return;
    const t = db.prepare(`SELECT SUM(qty_ordered) AS ord, SUM(qty_allocated) AS alloc, SUM(qty_picked) AS pick,
      SUM(qty_packed) AS pack, SUM(qty_shipped) AS ship FROM so_lines WHERE order_id = ?`).get(orderId);
    const openTasks = db.prepare(`SELECT COUNT(*) AS n FROM pick_tasks pt JOIN pick_lists pl ON pl.id = pt.pick_list_id
      WHERE pl.order_id = ? AND pt.status = 'OPEN'`).get(orderId).n;
    let s = 'NEW';
    if (t.ship === t.ord) s = 'SHIPPED';
    else if (t.ship > 0) s = 'PARTIALLY_SHIPPED';
    else if (t.pack === t.ord) s = 'PACKED';
    else if (t.pack > 0) s = 'PACKING';
    else if (t.pick === t.ord) s = 'PICKED';
    else if (t.pick > 0 || (openTasks > 0 && db.prepare("SELECT 1 FROM pick_lists WHERE order_id = ? AND status = 'IN_PROGRESS'").get(orderId))) s = 'PICKING';
    else if (t.alloc === t.ord) s = 'ALLOCATED';
    else if (t.alloc > 0) s = 'PARTIALLY_ALLOCATED';
    // after a partial shipment with remaining work, fall back to the furthest stage of the remainder
    if (s === 'PARTIALLY_SHIPPED' && t.pick === t.ship && t.alloc > t.pick) s = 'PARTIALLY_SHIPPED';
    db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?').run(s, orderId);
  }

  const orderDetail = (o) => ({
    ...o,
    site_code: db.prepare('SELECT code FROM sites WHERE id = ?').get(o.site_id).code,
    lines: db.prepare(`SELECT l.*, k.sku, k.description, k.barcode FROM so_lines l JOIN skus k ON k.id = l.sku_id WHERE order_id = ? ORDER BY line_no`).all(o.id),
    pick_lists: db.prepare('SELECT * FROM pick_lists WHERE order_id = ? ORDER BY id').all(o.id).map((p) => ({
      ...p, tasks: db.prepare(`SELECT pt.*, k.sku, k.barcode, k.description, l.code AS location_code, l.path FROM pick_tasks pt
        JOIN skus k ON k.id = pt.sku_id JOIN locations l ON l.id = pt.location_id WHERE pick_list_id = ? ORDER BY pt.pick_seq, l.path`).all(p.id) })),
    cartons: db.prepare('SELECT * FROM cartons WHERE order_id = ? ORDER BY id').all(o.id).map((c) => ({
      ...c, items: db.prepare('SELECT ci.*, k.sku, k.description FROM carton_items ci JOIN skus k ON k.id = ci.sku_id WHERE carton_id = ?').all(c.id) })),
    shipments: db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY id').all(o.id),
  });

  // ============================================================ ORDERS
  r.post('/orders', whse, (req, res) => {
    const b = req.body;
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(b.site_id));
    if (!site || site.site_type !== 'WAREHOUSE') throw bad('site_id must be the WAREHOUSE that fulfils the order');
    for (const f of ['customer_name', 'ship_to_line1', 'ship_to_city', 'ship_to_postal_code', 'ship_to_country'])
      if (blank(b[f])) throw bad(`${f} is required`);
    if (!Array.isArray(b.lines) || !b.lines.length) throw bad('At least one line is required');
    const merged = new Map();
    for (const [i, l] of b.lines.entries()) {
      const sku = db.prepare('SELECT * FROM skus WHERE sku = ? OR id = ?').get(String(l.sku).toUpperCase(), /^\d+$/.test(String(l.sku)) ? Number(l.sku) : -1);
      if (!sku) throw bad(`Line ${i + 1}: SKU ${l.sku} not found`);
      if (sku.status !== 'ACTIVE') throw bad(`Line ${i + 1}: SKU ${sku.sku} is inactive`);
      merged.set(sku.id, (merged.get(sku.id) || 0) + S.posInt(l.qty, `Line ${i + 1} qty`));
    }
    const id = tx(db, () => {
      const num = `SO-${yr()}-${String(nextCounter(db, 'so-' + yr())).padStart(6, '0')}`;
      const info = db.prepare(`INSERT INTO sales_orders (order_number, site_id, customer_name, ship_to_line1, ship_to_city, ship_to_state, ship_to_postal_code, ship_to_country, carrier, service_level, priority, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(num, site.id, b.customer_name, b.ship_to_line1, b.ship_to_city, b.ship_to_state || null, b.ship_to_postal_code, b.ship_to_country,
        b.carrier || null, b.service_level || null, Number(b.priority) || 5, req.user);
      let n = 1;
      for (const [skuId, qty] of merged) db.prepare('INSERT INTO so_lines (order_id, line_no, sku_id, qty_ordered) VALUES (?,?,?,?)').run(info.lastInsertRowid, n++, skuId, qty);
      audit(db, req.user, 'order', info.lastInsertRowid, 'CREATE', { order_number: num });
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(orderDetail(order(id)));
  });

  r.get('/orders', (req, res) => {
    const { status } = req.query;
    res.json(db.prepare(`SELECT o.*, s.code AS site_code, SUM(l.qty_ordered) AS qty_ordered, SUM(l.qty_allocated) AS qty_allocated,
      SUM(l.qty_picked) AS qty_picked, SUM(l.qty_packed) AS qty_packed, SUM(l.qty_shipped) AS qty_shipped
      FROM sales_orders o JOIN sites s ON s.id = o.site_id JOIN so_lines l ON l.order_id = o.id
      ${status ? 'WHERE o.status = ?' : ''} GROUP BY o.id ORDER BY o.priority, o.id DESC`).all(...(status ? [status] : [])));
  });

  r.get('/orders/:id', (req, res) => res.json(orderDetail(order(Number(req.params.id)))));

  // ============================================================ ALLOCATE -> PICK LIST
  r.post('/orders/:id/allocate', whse, (req, res) => {
    const o = order(Number(req.params.id));
    if (['CANCELLED', 'SHIPPED'].includes(o.status)) throw conflict(`Order is ${o.status}`);
    const result = tx(db, () => {
      const lines = db.prepare('SELECT l.*, k.sku FROM so_lines l JOIN skus k ON k.id = l.sku_id WHERE order_id = ? ORDER BY line_no').all(o.id);
      const tasks = []; const shortages = []; const touched = new Set();
      for (const ln of lines) {
        const want = ln.qty_ordered - ln.qty_allocated;
        if (want <= 0) continue;
        let need = want;
        const rows = db.prepare(`SELECT st.location_id, (st.qty_on_hand - st.qty_allocated) AS avail, l.pick_sequence
          FROM stock st JOIN locations l ON l.id = st.location_id
          WHERE st.sku_id = ? AND l.site_id = ? AND l.pickable = 1 AND st.qty_on_hand - st.qty_allocated > 0
            AND st.cycle_count_flag = 0           -- bins with an unresolved short pick are not allocated from
          ORDER BY l.pick_sequence, l.path`).all(ln.sku_id, o.site_id);
        for (const row of rows) {
          if (need <= 0) break;
          const take = Math.min(need, row.avail);
          S.reserve(db, ln.sku_id, row.location_id, take);
          tasks.push({ so_line_id: ln.id, sku_id: ln.sku_id, location_id: row.location_id, qty: take, seq: row.pick_sequence });
          need -= take;
        }
        if (want - need > 0) { db.prepare('UPDATE so_lines SET qty_allocated = qty_allocated + ? WHERE id = ?').run(want - need, ln.id); touched.add(ln.sku_id); }
        if (need > 0) shortages.push({ sku: ln.sku, line_no: ln.line_no, short_qty: need });
      }
      let pickList = null;
      if (tasks.length) {
        const num = `PL-${yr()}-${String(nextCounter(db, 'pl-' + yr())).padStart(6, '0')}`;
        const info = db.prepare('INSERT INTO pick_lists (pick_number, order_id, site_id) VALUES (?,?,?)').run(num, o.id, o.site_id);
        for (const t of tasks)
          db.prepare('INSERT INTO pick_tasks (pick_list_id, so_line_id, sku_id, location_id, qty_to_pick, pick_seq) VALUES (?,?,?,?,?,?)')
            .run(info.lastInsertRowid, t.so_line_id, t.sku_id, t.location_id, t.qty, t.seq);
        pickList = { id: Number(info.lastInsertRowid), pick_number: num, tasks: tasks.length };
      }
      recomputeStatus(o.id);
      audit(db, req.user, 'order', o.id, 'ALLOCATE', { tasks: tasks.length, shortages });
      for (const skuId of touched) hooks.afterStockChange(skuId, o.site_id, req.user);   // available stock just dropped
      return { pick_list: pickList, shortages };
    });
    res.json({ ...result, order: orderDetail(order(o.id)) });
  });

  r.post('/orders/:id/cancel', whse, (req, res) => {
    const o = order(Number(req.params.id));
    if (o.status === 'CANCELLED') throw conflict('Order already cancelled');
    const picked = db.prepare('SELECT COALESCE(SUM(qty_picked),0) AS n FROM so_lines WHERE order_id = ?').get(o.id).n;
    if (picked > 0) throw conflict('Goods are already picked/packed for this order; return them to stock before cancelling');
    if (blank(req.body.reason)) throw bad('reason is required');
    tx(db, () => {
      const open = db.prepare(`SELECT pt.* FROM pick_tasks pt JOIN pick_lists pl ON pl.id = pt.pick_list_id WHERE pl.order_id = ? AND pt.status = 'OPEN'`).all(o.id);
      for (const t of open) S.release(db, t.sku_id, t.location_id, t.qty_to_pick);
      db.prepare('DELETE FROM pick_lists WHERE order_id = ?').run(o.id);
      db.prepare('UPDATE so_lines SET qty_allocated = 0 WHERE order_id = ?').run(o.id);
      db.prepare("UPDATE sales_orders SET status = 'CANCELLED' WHERE id = ?").run(o.id);
      audit(db, req.user, 'order', o.id, 'CANCELLED', req.body.reason);
    });
    res.json(orderDetail(order(o.id)));
  });

  // ============================================================ PICK
  r.get('/pick-lists', (req, res) => {
    const { status } = req.query;
    res.json(db.prepare(`SELECT p.*, o.order_number, o.priority, s.code AS site_code,
      (SELECT COUNT(*) FROM pick_tasks WHERE pick_list_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM pick_tasks WHERE pick_list_id = p.id AND status = 'OPEN') AS open_tasks
      FROM pick_lists p JOIN sales_orders o ON o.id = p.order_id JOIN sites s ON s.id = p.site_id
      ${status ? 'WHERE p.status = ?' : ''} ORDER BY o.priority, p.id`).all(...(status ? [status] : [])));
  });

  r.get('/pick-lists/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM pick_lists WHERE id = ?').get(Number(req.params.id));
    if (!p) throw notFound('Pick list');
    res.json({ ...p, order_number: order(p.order_id).order_number,
      tasks: db.prepare(`SELECT pt.*, k.sku, k.barcode, k.description, l.code AS location_code, l.path FROM pick_tasks pt
        JOIN skus k ON k.id = pt.sku_id JOIN locations l ON l.id = pt.location_id WHERE pick_list_id = ? ORDER BY pt.pick_seq, l.path`).all(p.id) });
  });

  /** Scan-verified pick. Short picks release the reservation, flag the bin for a cycle count, and leave the line to be re-allocated. */
  r.post('/pick-tasks/:id/confirm', whse, (req, res) => {
    const t = db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Pick task');
    if (t.status !== 'OPEN') throw conflict(`Pick task already ${t.status}`);
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(t.location_id);
    const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(t.sku_id);
    const qty = Number(req.body.qty_picked);
    if (!Number.isInteger(qty) || qty < 0 || qty > t.qty_to_pick) throw bad(`qty_picked must be a whole number from 0 to ${t.qty_to_pick}`);
    if (qty > 0) {   // verification scans are required whenever goods are taken
      if (String(req.body.scan_location || '').trim().toUpperCase() !== loc.code.toUpperCase()) throw conflict(`Wrong location scanned. Go to ${loc.code}`);
      if (!matchesItem(req.body.scan_item, sku)) throw conflict(`Wrong item scanned. Expected ${sku.sku}${sku.barcode ? ' / ' + sku.barcode : ''}`);
    }
    const shortQty = t.qty_to_pick - qty;
    if (shortQty > 0 && blank(req.body.short_reason)) throw bad('short_reason is required when picking less than requested');
    const pl = db.prepare('SELECT * FROM pick_lists WHERE id = ?').get(t.pick_list_id);
    const staging = stagingFor(pl.site_id);
    tx(db, () => {
      if (qty > 0) {
        S.removeStock(db, t.sku_id, t.location_id, qty, { fromAllocated: true });
        S.addStock(db, t.sku_id, staging.id, qty, { allocated: qty });
        S.ledger(db, { skuId: t.sku_id, from: t.location_id, to: staging.id, qty, type: 'PICK', refType: 'PICK_TASK', refId: t.id, actor: req.user });
        db.prepare('UPDATE so_lines SET qty_picked = qty_picked + ? WHERE id = ?').run(qty, t.so_line_id);
      }
      if (shortQty > 0) {
        S.release(db, t.sku_id, t.location_id, shortQty);
        db.prepare('UPDATE so_lines SET qty_allocated = qty_allocated - ? WHERE id = ?').run(shortQty, t.so_line_id);
        db.prepare('UPDATE stock SET cycle_count_flag = 1 WHERE sku_id = ? AND location_id = ?').run(t.sku_id, t.location_id);
        audit(db, req.user, 'pick_task', t.id, 'SHORT_PICK', { sku: sku.sku, location: loc.code, short: shortQty, reason: req.body.short_reason });
      }
      db.prepare(`UPDATE pick_tasks SET qty_picked = ?, status = ?, picked_by = ?, picked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), short_reason = ? WHERE id = ?`)
        .run(qty, shortQty > 0 ? 'SHORT' : 'PICKED', req.user, shortQty > 0 ? req.body.short_reason : null, t.id);
      const left = db.prepare("SELECT COUNT(*) AS n FROM pick_tasks WHERE pick_list_id = ? AND status = 'OPEN'").get(pl.id).n;
      db.prepare(`UPDATE pick_lists SET status = ?, completed_at = CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id = ?`)
        .run(left === 0 ? 'COMPLETE' : 'IN_PROGRESS', left, pl.id);
      recomputeStatus(pl.order_id);
      if (shortQty > 0) hooks.afterStockChange(t.sku_id, pl.site_id, req.user);
    });
    res.json({ task: db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(t.id), order_status: order(pl.order_id).status,
      short_qty: shortQty, note: shortQty > 0 ? 'Short pick recorded. Re-run allocation to source the remainder from another bin.' : undefined });
  });

  // ============================================================ PACK
  r.post('/orders/:id/cartons', whse, (req, res) => {
    const o = order(Number(req.params.id));
    const todo = db.prepare('SELECT COALESCE(SUM(qty_picked - qty_packed),0) AS n FROM so_lines WHERE order_id = ?').get(o.id).n;
    if (todo <= 0) throw conflict('Nothing picked and waiting to be packed for this order');
    const open = db.prepare("SELECT 1 FROM cartons c WHERE order_id = ? AND status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM carton_items WHERE carton_id = c.id)").get(o.id);
    if (open) throw conflict('There is already an empty open carton for this order');
    const id = tx(db, () => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM cartons WHERE order_id = ?').get(o.id).n + 1;
      const info = db.prepare('INSERT INTO cartons (order_id, carton_number, packed_by) VALUES (?,?,?)').run(o.id, `${o.order_number}-C${String(n).padStart(2, '0')}`, req.user);
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(db.prepare('SELECT * FROM cartons WHERE id = ?').get(id));
  });

  const carton = (id) => { const c = db.prepare('SELECT * FROM cartons WHERE id = ?').get(id); if (!c) throw notFound('Carton'); return c; };

  /** Scan an item into a carton. Cannot pack more than was picked, or an item that is not on the order. */
  r.post('/cartons/:id/items', whse, (req, res) => {
    const c = carton(Number(req.params.id));
    if (c.status !== 'OPEN') throw conflict(`Carton is ${c.status}`);
    const qty = S.posInt(req.body.qty, 'qty');
    const lines = db.prepare(`SELECT l.*, k.sku, k.barcode FROM so_lines l JOIN skus k ON k.id = l.sku_id WHERE l.order_id = ?`).all(c.order_id);
    const line = lines.find((l) => matchesItem(req.body.scan_item, l));
    if (!line) throw conflict('Scanned item is not on this order');
    const avail = line.qty_picked - line.qty_packed;
    if (qty > avail) throw conflict(`Only ${avail} of ${line.sku} picked and not yet packed`);
    tx(db, () => {
      db.prepare('UPDATE so_lines SET qty_packed = qty_packed + ? WHERE id = ?').run(qty, line.id);
      const ex = db.prepare('SELECT * FROM carton_items WHERE carton_id = ? AND so_line_id = ?').get(c.id, line.id);
      if (ex) db.prepare('UPDATE carton_items SET qty = qty + ? WHERE id = ?').run(qty, ex.id);
      else db.prepare('INSERT INTO carton_items (carton_id, so_line_id, sku_id, qty) VALUES (?,?,?,?)').run(c.id, line.id, line.sku_id, qty);
      recomputeStatus(c.order_id);
    });
    res.status(201).json(db.prepare('SELECT ci.*, k.sku FROM carton_items ci JOIN skus k ON k.id = ci.sku_id WHERE carton_id = ?').all(c.id));
  });

  r.delete('/cartons/:id/items/:itemId', whse, (req, res) => {
    const c = carton(Number(req.params.id));
    if (c.status !== 'OPEN') throw conflict(`Carton is ${c.status}; reopen is not supported once closed`);
    const it = db.prepare('SELECT * FROM carton_items WHERE id = ? AND carton_id = ?').get(Number(req.params.itemId), c.id);
    if (!it) throw notFound('Carton item');
    tx(db, () => {
      db.prepare('UPDATE so_lines SET qty_packed = qty_packed - ? WHERE id = ?').run(it.qty, it.so_line_id);
      db.prepare('DELETE FROM carton_items WHERE id = ?').run(it.id);
      recomputeStatus(c.order_id);
    });
    res.json({ ok: true });
  });

  r.delete('/cartons/:id', whse, (req, res) => {
    const c = carton(Number(req.params.id));
    if (c.status !== 'OPEN' || db.prepare('SELECT 1 FROM carton_items WHERE carton_id = ?').get(c.id)) throw conflict('Only empty open cartons can be deleted');
    db.prepare('DELETE FROM cartons WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  /** Closing needs a measured weight + dimensions and assigns the GS1 SSCC-18 for the shipping label. */
  r.post('/cartons/:id/close', whse, (req, res) => {
    const c = carton(Number(req.params.id));
    if (c.status !== 'OPEN') throw conflict(`Carton is ${c.status}`);
    const items = db.prepare('SELECT ci.qty, k.weight_kg FROM carton_items ci JOIN skus k ON k.id = ci.sku_id WHERE carton_id = ?').all(c.id);
    if (!items.length) throw conflict('Cannot close an empty carton');
    const w = Number(req.body.weight_kg), L = Number(req.body.length_cm), W = Number(req.body.width_cm), H = Number(req.body.height_cm);
    if (!(w > 0)) throw bad('weight_kg (measured) must be greater than 0');
    if (!(L > 0 && W > 0 && H > 0)) throw bad('length_cm, width_cm and height_cm must be greater than 0');
    const expected = items.reduce((t, i) => t + (i.weight_kg || 0) * i.qty, 0);
    const warning = expected > 0 && w < expected * 0.95
      ? `Measured weight ${w} kg is lighter than the ${expected.toFixed(2)} kg of contents - check the carton contents` : undefined;
    const out = tx(db, () => {
      const serial = nextCounter(db, 'sscc');
      const s = makeSscc(serial);
      db.prepare(`UPDATE cartons SET status = 'CLOSED', sscc = ?, weight_kg = ?, length_cm = ?, width_cm = ?, height_cm = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(s.sscc, w, L, W, H, c.id);
      audit(db, req.user, 'carton', c.id, 'CLOSED', { sscc: s.sscc, weight_kg: w });
      return s;
    });
    res.json({ carton: carton(c.id), sscc_formatted: out.formatted, expected_weight_kg: Math.round(expected * 1000) / 1000, warning });
  });

  r.get('/cartons/:id/label', (req, res) => {
    const c = carton(Number(req.params.id));
    if (!c.sscc) throw conflict('Label is available once the carton is closed');
    const o = order(c.order_id);
    const sh = c.shipment_id ? db.prepare('SELECT * FROM shipments WHERE id = ?').get(c.shipment_id) : null;
    const serialLen = 16 - GS1_PREFIX.length;
    res.json({
      sscc: c.sscc, gs1_128_data: '00' + c.sscc,
      sscc_formatted: `(00) ${c.sscc[0]} ${GS1_PREFIX} ${c.sscc.slice(1 + GS1_PREFIX.length, 1 + GS1_PREFIX.length + serialLen)} ${c.sscc[17]}`,
      carton_number: c.carton_number, order_number: o.order_number, weight_kg: c.weight_kg,
      dimensions_cm: `${c.length_cm} x ${c.width_cm} x ${c.height_cm}`,
      ship_to: { name: o.customer_name, line1: o.ship_to_line1, city: o.ship_to_city, state: o.ship_to_state, postal_code: o.ship_to_postal_code, country: o.ship_to_country },
      carrier: sh?.carrier || o.carrier, service_level: sh?.service_level || o.service_level, tracking_number: sh?.tracking_number || null,
      contents: db.prepare('SELECT k.sku, k.description, ci.qty FROM carton_items ci JOIN skus k ON k.id = ci.sku_id WHERE carton_id = ?').all(c.id),
    });
  });

  r.get('/orders/:id/packing-slip', (req, res) => {
    const o = order(Number(req.params.id));
    res.json({
      order_number: o.order_number, created_at: o.created_at, customer: o.customer_name,
      ship_to: { line1: o.ship_to_line1, city: o.ship_to_city, state: o.ship_to_state, postal_code: o.ship_to_postal_code, country: o.ship_to_country },
      lines: db.prepare(`SELECT k.sku, k.description, l.qty_ordered, l.qty_shipped, (l.qty_ordered - l.qty_shipped) AS qty_backordered
        FROM so_lines l JOIN skus k ON k.id = l.sku_id WHERE order_id = ? ORDER BY line_no`).all(o.id),
      cartons: db.prepare("SELECT carton_number, sscc, weight_kg FROM cartons WHERE order_id = ? AND status != 'OPEN'").all(o.id),
    });
  });

  // ============================================================ SHIP
  r.post('/orders/:id/ship', whse, (req, res) => {
    const o = order(Number(req.params.id));
    const carrier = req.body.carrier || o.carrier;
    if (blank(carrier)) throw bad('carrier is required');
    if (blank(req.body.tracking_number)) throw bad('tracking_number is required to confirm shipment');
    let cartons = db.prepare("SELECT * FROM cartons WHERE order_id = ? AND status = 'CLOSED'").all(o.id);
    if (Array.isArray(req.body.carton_ids)) {
      const want = req.body.carton_ids.map(Number);
      const bad1 = want.filter((id) => !cartons.some((c) => c.id === id));
      if (bad1.length) throw conflict(`Carton(s) ${bad1.join(', ')} are not closed, not on this order, or already shipped`);
      cartons = cartons.filter((c) => want.includes(c.id));
    }
    if (!cartons.length) throw conflict('No closed cartons are ready to ship. Pack and close at least one carton first');
    const staging = stagingFor(o.site_id);
    const out = tx(db, () => {
      const num = `SHP-${yr()}-${String(nextCounter(db, 'shp-' + yr())).padStart(6, '0')}`;
      const bol = `BOL-${yr()}-${String(nextCounter(db, 'bol-' + yr())).padStart(6, '0')}`;
      const weight = cartons.reduce((t, c) => t + c.weight_kg, 0);
      const info = db.prepare(`INSERT INTO shipments (shipment_number, order_id, carrier, service_level, tracking_number, bol_number, total_weight_kg, shipped_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(num, o.id, carrier, req.body.service_level || o.service_level, String(req.body.tracking_number).trim(), bol, Math.round(weight * 1000) / 1000, req.user);
      for (const c of cartons) {
        for (const it of db.prepare('SELECT * FROM carton_items WHERE carton_id = ?').all(c.id)) {
          S.removeStock(db, it.sku_id, staging.id, it.qty, { fromAllocated: true });
          S.ledger(db, { skuId: it.sku_id, from: staging.id, qty: it.qty, type: 'SHIP', refType: 'SHIPMENT', refId: Number(info.lastInsertRowid), actor: req.user, note: `${num} / ${c.carton_number}` });
          db.prepare('UPDATE so_lines SET qty_shipped = qty_shipped + ? WHERE id = ?').run(it.qty, it.so_line_id);
        }
        db.prepare("UPDATE cartons SET status = 'SHIPPED', shipment_id = ? WHERE id = ?").run(info.lastInsertRowid, c.id);
      }
      recomputeStatus(o.id);
      audit(db, req.user, 'order', o.id, 'SHIPPED', { shipment: num, cartons: cartons.length, tracking: req.body.tracking_number });
      return { id: Number(info.lastInsertRowid), shipment_number: num, bol_number: bol, total_weight_kg: Math.round(weight * 1000) / 1000 };
    });
    res.status(201).json({ shipment: out, order_status: order(o.id).status });
  });

  return r;
}

module.exports = { fulfillmentRouter, ssccCheckDigit, makeSscc };
