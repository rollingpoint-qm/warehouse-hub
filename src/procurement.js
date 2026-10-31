'use strict';
const express = require('express');
const { tx, nextCounter, audit, bad, notFound, conflict } = require('./db');
const { allow } = require('./auth');
const S = require('./stock');
const { orderability, today, addDays } = require('./vendors');

/**
 * Min/Max replenishment.
 *   position = available (on-hand - reserved, all locations in the warehouse) + on order (open PO qty not yet received)
 *   position < MIN  ->  order up to MAX:  need = MAX - position
 * Counting open POs in the position is what stops the same shortage from raising a second PO.
 * The order quantity is rounded UP to the vendor's pack size and never below the vendor MOQ,
 * so it can exceed MAX by less than one pack.
 */
function candidateVendorItems(db, skuId) {
  const rows = db.prepare(`SELECT vi.*, v.vendor_code, v.legal_name, v.currency, v.payment_terms
    FROM vendor_items vi JOIN vendors v ON v.id = vi.vendor_id
    WHERE vi.sku_id = ? AND vi.status = 'ACTIVE'
    ORDER BY vi.is_preferred DESC, vi.unit_cost ASC, vi.lead_time_days ASC`).all(skuId);
  return rows.filter((vi) => orderability(db, vi.vendor_id).ok);
}

function evaluatePolicy(db, p) {
  const sku = db.prepare('SELECT sku, description FROM skus WHERE id = ?').get(p.sku_id);
  const site = db.prepare('SELECT code, name FROM sites WHERE id = ?').get(p.site_id);
  const onHand = S.onHandAtSite(db, p.sku_id, p.site_id);
  const available = S.availableAtSite(db, p.sku_id, p.site_id);
  const onOrder = S.onOrderAtSite(db, p.sku_id, p.site_id);
  const position = available + onOrder;
  const out = { policy_id: p.id, sku_id: p.sku_id, sku: sku.sku, description: sku.description, site_id: p.site_id,
    site_code: site.code, min_qty: p.min_qty, max_qty: p.max_qty, on_hand: onHand, available, on_order: onOrder, position };
  if (position >= p.min_qty) {
    out.state = available < p.min_qty ? 'ON_ORDER' : 'OK';
    return out;
  }
  out.state = 'REORDER_NEEDED';
  const vi = candidateVendorItems(db, p.sku_id)[0];
  if (!vi) { out.state = 'NO_ELIGIBLE_VENDOR'; return out; }
  const need = p.max_qty - position;
  const packs = Math.max(Math.ceil(need / vi.pack_size), vi.min_order_qty);
  out.vendor_item = { id: vi.id, vendor_id: vi.vendor_id, vendor_code: vi.vendor_code, vendor_item_number: vi.vendor_item_number };
  out.order_qty = packs; out.order_qty_base = packs * vi.pack_size; out.vendor = vi;
  return out;
}

function createPurchaseOrder(db, { vendorId, siteId, lines, source, actor, expectedDate, notes }) {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendorId);
  const year = new Date().getFullYear();
  const num = `PO-${year}-${String(nextCounter(db, 'po-' + year)).padStart(6, '0')}`;
  const total = lines.reduce((t, l) => t + l.qty * l.vi.unit_cost, 0);
  const lead = Math.max(...lines.map((l) => l.vi.lead_time_days));
  const info = db.prepare(`INSERT INTO purchase_orders (po_number, vendor_id, site_id, source, currency, payment_terms, expected_date, total_amount, created_by, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(num, vendorId, siteId, source, v.currency, v.payment_terms, expectedDate || addDays(today(), lead), Math.round(total * 100) / 100, actor, notes || null);
  const poId = Number(info.lastInsertRowid);
  lines.forEach((l, i) => {
    const sku = db.prepare('SELECT description FROM skus WHERE id = ?').get(l.vi.sku_id);
    db.prepare(`INSERT INTO po_lines (po_id, line_no, vendor_item_id, vendor_item_number, sku_id, description, qty_ordered, pack_size, vendor_uom, unit_cost)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(poId, i + 1, l.vi.id, l.vi.vendor_item_number, l.vi.sku_id, sku.description, l.qty, l.vi.pack_size, l.vi.vendor_uom, l.vi.unit_cost);
  });
  audit(db, actor, 'purchase_order', poId, 'CREATE', { po_number: num, source, vendor: v.vendor_code, lines: lines.length });
  return { id: poId, po_number: num, vendor_code: v.vendor_code, total_amount: Math.round(total * 100) / 100 };
}

/** Evaluate policies (optionally one SKU/site) and raise POs, one per vendor+warehouse. */
function runReorder(db, actor, { skuId, siteId } = {}) {
  return tx(db, () => {
    let sql = 'SELECT * FROM reorder_policies WHERE active = 1'; const p = [];
    if (skuId) { sql += ' AND sku_id = ?'; p.push(skuId); }
    if (siteId) { sql += ' AND site_id = ?'; p.push(siteId); }
    const results = db.prepare(sql).all(...p).map((pol) => evaluatePolicy(db, pol));
    const groups = new Map();
    for (const r of results.filter((x) => x.state === 'REORDER_NEEDED')) {
      const key = `${r.vendor_item.vendor_id}:${r.site_id}`;
      if (!groups.has(key)) groups.set(key, { vendorId: r.vendor_item.vendor_id, siteId: r.site_id, lines: [] });
      groups.get(key).lines.push({ vi: r.vendor, qty: r.order_qty });
    }
    const created = [];
    for (const g of groups.values())
      created.push(createPurchaseOrder(db, { ...g, source: 'AUTO_REORDER', actor: `system:reorder(${actor})`,
        notes: 'Auto-generated: stock fell below minimum' }));
    const blocked = results.filter((x) => x.state === 'NO_ELIGIBLE_VENDOR');
    for (const b of blocked)
      audit(db, actor, 'sku', b.sku_id, 'REORDER_BLOCKED', { site: b.site_code, reason: 'No active vendor item from an eligible vendor', position: b.position, min: b.min_qty });
    return { created, blocked: blocked.map((b) => ({ sku: b.sku, site: b.site_code, position: b.position, min: b.min_qty })) };
  });
}

function procurementRouter(db) {
  const r = express.Router();
  const buyer = allow('PROCUREMENT');
  const whse = allow('WAREHOUSE');

  const po = (id) => { const p = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id); if (!p) throw notFound('Purchase order'); return p; };

  r.get('/reorder/status', (req, res) => {
    const rows = db.prepare('SELECT * FROM reorder_policies WHERE active = 1').all().map((p) => {
      const e = evaluatePolicy(db, p); delete e.vendor; return e;
    });
    res.json(rows);
  });

  r.post('/reorder/run', buyer, (req, res) => res.json(runReorder(db, req.user)));

  r.post('/purchase-orders', buyer, (req, res) => {
    const { vendor_id, site_id, lines, expected_date, notes } = req.body;
    const o = orderability(db, Number(vendor_id));
    if (!o.ok) throw conflict(`Cannot raise a PO: ${o.reason}`);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(site_id));
    if (!site || site.site_type !== 'WAREHOUSE') throw bad('site_id must be a WAREHOUSE (ship-to)');
    if (!Array.isArray(lines) || !lines.length) throw bad('At least one line is required');
    const seen = new Set();
    const resolved = lines.map((l, i) => {
      const vin = String(l.vendor_item_number || '').trim();
      if (!vin) throw bad(`Line ${i + 1}: vendor_item_number is required`);
      if (seen.has(vin)) throw bad(`Line ${i + 1}: duplicate vendor item number ${vin}`);
      seen.add(vin);
      const vi = db.prepare("SELECT * FROM vendor_items WHERE vendor_id = ? AND vendor_item_number = ? AND status = 'ACTIVE'").get(Number(vendor_id), vin);
      if (!vi) throw bad(`Line ${i + 1}: vendor item number ${vin} is not an active item for this vendor`);
      const qty = S.posInt(l.qty, `Line ${i + 1} qty`);
      if (qty < vi.min_order_qty) throw bad(`Line ${i + 1}: minimum order quantity is ${vi.min_order_qty} ${vi.vendor_uom}`);
      return { vi, qty };
    });
    const created = tx(db, () => createPurchaseOrder(db, { vendorId: Number(vendor_id), siteId: site.id, lines: resolved, source: 'MANUAL', actor: req.user, expectedDate: expected_date, notes }));
    res.status(201).json(created);
  });

  r.get('/purchase-orders', (req, res) => {
    const { status, vendor_id } = req.query; const w = []; const p = [];
    if (status) { w.push('po.status = ?'); p.push(status); }
    if (vendor_id) { w.push('po.vendor_id = ?'); p.push(Number(vendor_id)); }
    res.json(db.prepare(`SELECT po.*, v.vendor_code, v.legal_name, s.code AS site_code,
      (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS line_count
      FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id JOIN sites s ON s.id = po.site_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY po.id DESC`).all(...p));
  });

  r.get('/purchase-orders/:id', (req, res) => {
    const p = po(Number(req.params.id));
    res.json({
      ...p,
      vendor: db.prepare('SELECT id, vendor_code, legal_name, primary_contact_email, payment_terms, currency FROM vendors WHERE id = ?').get(p.vendor_id),
      site: db.prepare('SELECT code, name FROM sites WHERE id = ?').get(p.site_id),
      lines: db.prepare('SELECT pl.*, k.sku FROM po_lines pl JOIN skus k ON k.id = pl.sku_id WHERE po_id = ? ORDER BY line_no').all(p.id),
      receipts: db.prepare(`SELECT r.*, pl.vendor_item_number, l.code AS location_code FROM po_receipts r
        JOIN po_lines pl ON pl.id = r.po_line_id JOIN locations l ON l.id = r.location_id WHERE pl.po_id = ? ORDER BY r.id`).all(p.id),
    });
  });

  r.post('/purchase-orders/:id/receive', whse, (req, res) => {
    const p = po(Number(req.params.id));
    if (!['OPEN', 'PARTIALLY_RECEIVED'].includes(p.status)) throw conflict(`PO is ${p.status}; nothing to receive`);
    const lines = req.body.lines;
    if (!Array.isArray(lines) || !lines.length) throw bad('lines are required');
    const defaultLoc = db.prepare("SELECT * FROM locations WHERE site_id = ? AND loc_type = 'DOCK' ORDER BY id LIMIT 1").get(p.site_id);
    tx(db, () => {
      for (const [i, l] of lines.entries()) {
        const pl = db.prepare('SELECT * FROM po_lines WHERE po_id = ? AND vendor_item_number = ?').get(p.id, String(l.vendor_item_number || '').trim());
        if (!pl) throw bad(`Line ${i + 1}: vendor item number ${l.vendor_item_number} is not on this PO`);
        const qty = S.posInt(l.qty, `Line ${i + 1} qty`);
        if (pl.qty_received + qty > pl.qty_ordered)
          throw conflict(`Line ${i + 1}: receiving ${qty} would exceed the ordered quantity (${pl.qty_ordered - pl.qty_received} ${pl.vendor_uom} outstanding)`);
        const loc = l.location
          ? db.prepare('SELECT * FROM locations WHERE code = ? AND site_id = ?').get(String(l.location), p.site_id)
          : defaultLoc;
        if (!loc) throw bad(`Line ${i + 1}: location ${l.location} not found in the PO's warehouse`);
        if (loc.loc_type === 'STAGING') throw bad(`Line ${i + 1}: cannot receive into outbound staging`);
        const base = qty * pl.pack_size;
        db.prepare('UPDATE po_lines SET qty_received = qty_received + ? WHERE id = ?').run(qty, pl.id);
        db.prepare('INSERT INTO po_receipts (po_line_id, qty_vendor_uom, qty_base, location_id, received_by) VALUES (?,?,?,?,?)').run(pl.id, qty, base, loc.id, req.user);
        S.addStock(db, pl.sku_id, loc.id, base);
        S.ledger(db, { skuId: pl.sku_id, to: loc.id, qty: base, type: 'RECEIPT', refType: 'PO', refId: p.id, actor: req.user, note: `${p.po_number} / ${pl.vendor_item_number}` });
      }
      const open = db.prepare('SELECT COUNT(*) AS n FROM po_lines WHERE po_id = ? AND qty_received < qty_ordered').get(p.id).n;
      const any = db.prepare('SELECT COALESCE(SUM(qty_received),0) AS n FROM po_lines WHERE po_id = ?').get(p.id).n;
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(open === 0 ? 'RECEIVED' : any > 0 ? 'PARTIALLY_RECEIVED' : 'OPEN', p.id);
      audit(db, req.user, 'purchase_order', p.id, 'RECEIVED', lines);
    });
    res.json(po(p.id));
  });

  r.post('/purchase-orders/:id/cancel', buyer, (req, res) => {
    const p = po(Number(req.params.id));
    if (p.status !== 'OPEN') throw conflict(`Only OPEN purchase orders with nothing received can be cancelled (this one is ${p.status})`);
    if (!req.body.reason) throw bad('reason is required');
    db.prepare("UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = ?").run(p.id);
    audit(db, req.user, 'purchase_order', p.id, 'CANCELLED', req.body.reason);
    res.json(po(p.id));
  });

  return r;
}

module.exports = { procurementRouter, runReorder, evaluatePolicy };
