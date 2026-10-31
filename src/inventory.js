'use strict';
const express = require('express');
const { tx, nextCounter, audit, bad, notFound, conflict } = require('./db');
const { allow } = require('./auth');
const S = require('./stock');
const { orderability } = require('./vendors');

const LOC_TYPES = ['ZONE', 'AISLE', 'RACK', 'SHELF', 'BIN', 'DOCK', 'STAGING', 'PACK_STATION', 'VEHICLE', 'COMPARTMENT'];
const blank = (x) => x === null || x === undefined || String(x).trim() === '';

function inventoryRouter(db, hooks) {
  const r = express.Router();
  const master = allow('PROCUREMENT', 'WAREHOUSE');   // sites, locations, SKUs
  const buyer = allow('PROCUREMENT');
  const whse = allow('WAREHOUSE');

  const site = (id) => { const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(id); if (!s) throw notFound('Site'); return s; };
  const skuByRef = (ref) => {
    const s = /^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM skus WHERE id = ?').get(Number(ref))
      : db.prepare('SELECT * FROM skus WHERE sku = ?').get(String(ref).toUpperCase());
    if (!s) throw notFound(`SKU ${ref}`);
    return s;
  };
  const locByRef = (ref, siteId) => {
    const l = /^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(ref))
      : db.prepare('SELECT * FROM locations WHERE code = ? AND (? IS NULL OR site_id = ?)').get(String(ref), siteId ?? null, siteId ?? null);
    if (!l) throw notFound(`Location ${ref}`);
    return l;
  };
  const addLocation = (siteId, { code, name, loc_type, parent_id, pickable, pick_sequence }) => {
    if (blank(code)) throw bad('code is required');
    if (!LOC_TYPES.includes(loc_type)) throw bad(`loc_type must be one of ${LOC_TYPES.join(', ')}`);
    let path = String(code);
    if (parent_id) {
      const p = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(parent_id));
      if (!p) throw notFound('Parent location');
      if (p.site_id !== siteId) throw bad('Parent location belongs to a different site');
      path = `${p.path}/${code}`;
    }
    if (db.prepare('SELECT 1 FROM locations WHERE site_id = ? AND code = ?').get(siteId, code)) throw conflict(`Location code ${code} already exists in this site`);
    const info = db.prepare(`INSERT INTO locations (site_id, parent_id, code, name, loc_type, pickable, pick_sequence, path) VALUES (?,?,?,?,?,?,?,?)`)
      .run(siteId, parent_id ? Number(parent_id) : null, code, name || null, loc_type, pickable ? 1 : 0, Number(pick_sequence) || 0, path);
    return db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid);
  };

  // ============================================================ SITES
  r.post('/sites', master, (req, res) => {
    const { code, name, site_type, home_warehouse_id, address, city, state, country } = req.body;
    if (blank(code) || blank(name)) throw bad('code and name are required');
    if (!['WAREHOUSE', 'FLEET'].includes(site_type)) throw bad("site_type must be 'WAREHOUSE' or 'FLEET'");
    if (site_type === 'FLEET') {
      if (!home_warehouse_id) throw bad('A fleet must reference its home_warehouse_id');
      if (site(Number(home_warehouse_id)).site_type !== 'WAREHOUSE') throw bad('home_warehouse_id must be a WAREHOUSE');
    }
    if (db.prepare('SELECT 1 FROM sites WHERE code = ?').get(code)) throw conflict(`Site code ${code} already exists`);
    const created = tx(db, () => {
      const info = db.prepare(`INSERT INTO sites (code, name, site_type, home_warehouse_id, address, city, state, country) VALUES (?,?,?,?,?,?,?,?)`)
        .run(code, name, site_type, site_type === 'FLEET' ? Number(home_warehouse_id) : null, address || null, city || null, state || null, country || null);
      const id = Number(info.lastInsertRowid);
      if (site_type === 'WAREHOUSE') {      // every warehouse gets the standard dock + staging locations
        addLocation(id, { code: `${code}-RECV`, name: 'Receiving dock', loc_type: 'DOCK', pickable: false });
        addLocation(id, { code: `${code}-STAGE`, name: 'Outbound staging', loc_type: 'STAGING', pickable: false });
      }
      audit(db, req.user, 'site', id, 'CREATE', { code, site_type });
      return id;
    });
    res.status(201).json(site(created));
  });

  r.get('/sites', (req, res) => {
    res.json(db.prepare(`SELECT s.*, h.code AS home_warehouse_code,
      (SELECT COUNT(*) FROM locations l WHERE l.site_id = s.id) AS location_count,
      (SELECT COALESCE(SUM(st.qty_on_hand),0) FROM stock st JOIN locations l ON l.id = st.location_id WHERE l.site_id = s.id) AS units_on_hand
      FROM sites s LEFT JOIN sites h ON h.id = s.home_warehouse_id ORDER BY s.site_type, s.code`).all());
  });

  r.get('/sites/:id', (req, res) => {
    const s = site(Number(req.params.id));
    res.json({ ...s, locations: db.prepare('SELECT * FROM locations WHERE site_id = ? ORDER BY path').all(s.id),
      fleets: s.site_type === 'WAREHOUSE' ? db.prepare('SELECT * FROM sites WHERE home_warehouse_id = ?').all(s.id) : undefined });
  });

  r.post('/sites/:id/locations', master, (req, res) => {
    const s = site(Number(req.params.id));
    const loc = tx(db, () => {
      const l = addLocation(s.id, req.body);
      audit(db, req.user, 'location', l.id, 'CREATE', { site: s.code, code: l.code });
      return l;
    });
    res.status(201).json(loc);
  });

  r.get('/locations', (req, res) => {
    const { site_id } = req.query;
    res.json(db.prepare(`SELECT l.*, s.code AS site_code FROM locations l JOIN sites s ON s.id = l.site_id
      ${site_id ? 'WHERE l.site_id = ?' : ''} ORDER BY s.code, l.path`).all(...(site_id ? [Number(site_id)] : [])));
  });

  // ============================================================ SKUs
  r.post('/skus', master, (req, res) => {
    const b = req.body;
    if (blank(b.description)) throw bad('description is required');
    let sku = blank(b.sku) ? null : String(b.sku).trim().toUpperCase();
    if (sku && !/^[A-Z0-9][A-Z0-9-]{3,29}$/.test(sku)) throw bad('sku must be 4-30 chars of A-Z, 0-9 and dashes');
    if (sku && db.prepare('SELECT 1 FROM skus WHERE sku = ?').get(sku)) throw conflict(`SKU ${sku} already exists`);
    if (b.barcode && db.prepare('SELECT 1 FROM skus WHERE barcode = ?').get(String(b.barcode))) throw conflict(`Barcode ${b.barcode} is already assigned to another SKU`);
    const num = (x) => (blank(x) ? null : Number(x));
    const id = tx(db, () => {
      if (!sku) sku = 'SKU-' + String(nextCounter(db, 'sku')).padStart(6, '0');
      const info = db.prepare(`INSERT INTO skus (sku, description, category, base_uom, barcode, weight_kg, length_cm, width_cm, height_cm, hazmat)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(sku, b.description, b.category || null, b.base_uom || 'EA', blank(b.barcode) ? null : String(b.barcode),
        num(b.weight_kg), num(b.length_cm), num(b.width_cm), num(b.height_cm), b.hazmat ? 1 : 0);
      audit(db, req.user, 'sku', info.lastInsertRowid, 'CREATE', { sku });
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(db.prepare('SELECT * FROM skus WHERE id = ?').get(id));
  });

  r.get('/skus', (req, res) => {
    const q = req.query.q;
    const rows = db.prepare(`SELECT k.*,
      (SELECT COALESCE(SUM(qty_on_hand),0) FROM stock WHERE sku_id = k.id) AS on_hand,
      (SELECT COALESCE(SUM(qty_allocated),0) FROM stock WHERE sku_id = k.id) AS allocated,
      (SELECT COUNT(*) FROM vendor_items WHERE sku_id = k.id) AS vendor_item_count
      FROM skus k ${q ? 'WHERE k.sku LIKE ? OR k.description LIKE ? OR k.barcode LIKE ?' : ''} ORDER BY k.sku`)
      .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
    res.json(rows);
  });

  r.get('/skus/:ref', (req, res) => {
    const k = skuByRef(req.params.ref);
    res.json({
      ...k,
      vendor_items: db.prepare(`SELECT vi.*, v.vendor_code, v.legal_name, v.status AS vendor_status FROM vendor_items vi
        JOIN vendors v ON v.id = vi.vendor_id WHERE vi.sku_id = ? ORDER BY vi.is_preferred DESC, vi.unit_cost`).all(k.id),
      stock: db.prepare(`SELECT st.*, l.code AS location_code, l.path, s.code AS site_code, s.site_type FROM stock st
        JOIN locations l ON l.id = st.location_id JOIN sites s ON s.id = l.site_id WHERE st.sku_id = ? ORDER BY s.code, l.path`).all(k.id),
      reorder_policies: db.prepare('SELECT rp.*, s.code AS site_code FROM reorder_policies rp JOIN sites s ON s.id = rp.site_id WHERE rp.sku_id = ?').all(k.id),
    });
  });

  // ============================================================ SKU <-> VENDOR ITEM NUMBER
  r.post('/skus/:ref/vendor-items', buyer, (req, res) => {
    const k = skuByRef(req.params.ref);
    const b = req.body;
    const vendorId = Number(b.vendor_id);
    const o = orderability(db, vendorId);
    if (!o.ok) throw conflict(`Cannot map items to this vendor: ${o.reason}`);
    if (blank(b.vendor_item_number)) throw bad('vendor_item_number is required');
    const vin = String(b.vendor_item_number).trim();
    if (!(Number(b.unit_cost) >= 0) || blank(b.unit_cost)) throw bad('unit_cost must be 0 or more');
    const pack = b.pack_size === undefined ? 1 : S.posInt(b.pack_size, 'pack_size');
    const moq = b.min_order_qty === undefined ? 1 : S.posInt(b.min_order_qty, 'min_order_qty');
    if (db.prepare('SELECT 1 FROM vendor_items WHERE vendor_id = ? AND vendor_item_number = ?').get(vendorId, vin))
      throw conflict(`Vendor item number ${vin} already exists for this vendor`);
    if (db.prepare('SELECT 1 FROM vendor_items WHERE vendor_id = ? AND sku_id = ?').get(vendorId, k.id))
      throw conflict('This vendor already has an item mapped to this SKU');
    const id = tx(db, () => {
      const hasAny = db.prepare('SELECT 1 FROM vendor_items WHERE sku_id = ?').get(k.id);
      const preferred = b.is_preferred || !hasAny ? 1 : 0;   // first vendor becomes preferred
      if (preferred) db.prepare('UPDATE vendor_items SET is_preferred = 0 WHERE sku_id = ?').run(k.id);
      const info = db.prepare(`INSERT INTO vendor_items (vendor_id, sku_id, vendor_item_number, vendor_uom, pack_size, unit_cost, min_order_qty, lead_time_days, is_preferred)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(vendorId, k.id, vin, b.vendor_uom || 'EA', pack, Number(b.unit_cost), moq, Number(b.lead_time_days) || 7, preferred);
      audit(db, req.user, 'sku', k.id, 'VENDOR_ITEM_MAPPED', { vendor_id: vendorId, vendor_item_number: vin });
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(db.prepare('SELECT * FROM vendor_items WHERE id = ?').get(id));
  });

  r.post('/vendor-items/:id/prefer', buyer, (req, res) => {
    const vi = db.prepare('SELECT * FROM vendor_items WHERE id = ?').get(Number(req.params.id));
    if (!vi) throw notFound('Vendor item');
    tx(db, () => {
      db.prepare('UPDATE vendor_items SET is_preferred = 0 WHERE sku_id = ?').run(vi.sku_id);
      db.prepare('UPDATE vendor_items SET is_preferred = 1 WHERE id = ?').run(vi.id);
    });
    res.json(db.prepare('SELECT * FROM vendor_items WHERE id = ?').get(vi.id));
  });

  r.patch('/vendor-items/:id', buyer, (req, res) => {
    const vi = db.prepare('SELECT * FROM vendor_items WHERE id = ?').get(Number(req.params.id));
    if (!vi) throw notFound('Vendor item');
    const b = req.body; const sets = []; const vals = [];
    for (const f of ['unit_cost', 'lead_time_days']) if (f in b) { if (!(Number(b[f]) >= 0)) throw bad(`${f} must be 0 or more`); sets.push(`${f} = ?`); vals.push(Number(b[f])); }
    for (const f of ['pack_size', 'min_order_qty']) if (f in b) { sets.push(`${f} = ?`); vals.push(S.posInt(b[f], f)); }
    if ('status' in b) { if (!['ACTIVE', 'INACTIVE'].includes(b.status)) throw bad('status must be ACTIVE or INACTIVE'); sets.push('status = ?'); vals.push(b.status); }
    if (!sets.length) throw bad('Nothing to update');
    db.prepare(`UPDATE vendor_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, vi.id);
    audit(db, req.user, 'vendor_item', vi.id, 'UPDATE', b);
    res.json(db.prepare('SELECT * FROM vendor_items WHERE id = ?').get(vi.id));
  });

  r.get('/vendor-items', (req, res) => {
    res.json(db.prepare(`SELECT vi.*, k.sku, k.description, v.vendor_code, v.legal_name, v.status AS vendor_status
      FROM vendor_items vi JOIN skus k ON k.id = vi.sku_id JOIN vendors v ON v.id = vi.vendor_id ORDER BY k.sku, vi.is_preferred DESC`).all());
  });

  // ============================================================ STOCK
  r.get('/stock', (req, res) => {
    const { site_id, sku } = req.query; const w = []; const p = [];
    if (site_id) { w.push('l.site_id = ?'); p.push(Number(site_id)); }
    if (sku) { w.push('k.sku = ?'); p.push(String(sku).toUpperCase()); }
    res.json(db.prepare(`SELECT st.sku_id, k.sku, k.description, st.location_id, l.code AS location_code, l.path, l.loc_type,
      s.id AS site_id, s.code AS site_code, s.site_type, st.qty_on_hand, st.qty_allocated,
      (st.qty_on_hand - st.qty_allocated) AS qty_available, st.cycle_count_flag
      FROM stock st JOIN skus k ON k.id = st.sku_id JOIN locations l ON l.id = st.location_id JOIN sites s ON s.id = l.site_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.code, l.path, k.sku`).all(...p));
  });

  r.get('/movements', (req, res) => {
    const { sku } = req.query;
    res.json(db.prepare(`SELECT m.*, k.sku, fl.code AS from_code, tl.code AS to_code FROM stock_movements m
      JOIN skus k ON k.id = m.sku_id LEFT JOIN locations fl ON fl.id = m.from_location_id LEFT JOIN locations tl ON tl.id = m.to_location_id
      ${sku ? 'WHERE k.sku = ?' : ''} ORDER BY m.id DESC LIMIT 200`).all(...(sku ? [String(sku).toUpperCase()] : [])));
  });

  /** Move stock between locations: put-away, bin-to-bin, or warehouse -> fleet vehicle. */
  r.post('/transfers', whse, (req, res) => {
    const k = skuByRef(req.body.sku);
    const from = locByRef(req.body.from_location); const to = locByRef(req.body.to_location);
    const qty = S.posInt(req.body.qty, 'qty');
    if (from.id === to.id) throw bad('Source and destination are the same location');
    tx(db, () => {
      S.removeStock(db, k.id, from.id, qty);
      S.addStock(db, k.id, to.id, qty);
      S.ledger(db, { skuId: k.id, from: from.id, to: to.id, qty, type: from.site_id === to.site_id ? 'TRANSFER' : 'TRANSFER_SITE', actor: req.user, note: req.body.note });
      hooks.afterStockChange(k.id, from.site_id, req.user);
    });
    res.status(201).json({ ok: true, sku: k.sku, from: from.code, to: to.code, qty });
  });

  /** Cycle-count / correction. Reason is mandatory and the delta is written to the ledger. */
  r.post('/adjustments', whse, (req, res) => {
    const k = skuByRef(req.body.sku); const loc = locByRef(req.body.location);
    const newQty = Number(req.body.new_qty);
    if (!Number.isInteger(newQty) || newQty < 0) throw bad('new_qty must be a whole number >= 0');
    if (blank(req.body.reason)) throw bad('reason is required for stock adjustments');
    const row = S.getRow(db, k.id, loc.id) || { qty_on_hand: 0, qty_allocated: 0 };
    if (newQty < row.qty_allocated) throw conflict(`Cannot adjust below the ${row.qty_allocated} units reserved for orders`);
    const delta = newQty - row.qty_on_hand;
    if (delta === 0) return res.json({ ok: true, delta: 0 });
    tx(db, () => {
      if (delta > 0) S.addStock(db, k.id, loc.id, delta); else S.removeStock(db, k.id, loc.id, -delta);
      db.prepare('UPDATE stock SET cycle_count_flag = 0 WHERE sku_id = ? AND location_id = ?').run(k.id, loc.id);
      S.ledger(db, { skuId: k.id, from: delta < 0 ? loc.id : null, to: delta > 0 ? loc.id : null, qty: Math.abs(delta), type: 'ADJUSTMENT', actor: req.user, note: req.body.reason });
      audit(db, req.user, 'stock', k.id, 'ADJUSTMENT', { location: loc.code, from: row.qty_on_hand, to: newQty, reason: req.body.reason });
      hooks.afterStockChange(k.id, loc.site_id, req.user);
    });
    res.status(201).json({ ok: true, delta });
  });

  // ============================================================ REORDER POLICIES (min / max)
  r.put('/reorder-policies', buyer, (req, res) => {
    const k = skuByRef(req.body.sku); const s = site(Number(req.body.site_id));
    const min = Number(req.body.min_qty); const max = Number(req.body.max_qty);
    if (s.site_type !== 'WAREHOUSE') throw bad('Min/max policies drive purchase orders, so they apply to WAREHOUSE sites');
    if (!Number.isInteger(min) || min < 0) throw bad('min_qty must be a whole number >= 0');
    if (!Number.isInteger(max) || max <= min) throw bad('max_qty must be a whole number greater than min_qty');
    tx(db, () => {
      db.prepare(`INSERT INTO reorder_policies (sku_id, site_id, min_qty, max_qty, active) VALUES (?,?,?,?,1)
        ON CONFLICT(sku_id, site_id) DO UPDATE SET min_qty = excluded.min_qty, max_qty = excluded.max_qty, active = 1`).run(k.id, s.id, min, max);
      audit(db, req.user, 'sku', k.id, 'REORDER_POLICY', { site: s.code, min, max });
      hooks.afterStockChange(k.id, s.id, req.user);       // evaluate immediately under the new thresholds
    });
    res.json(db.prepare('SELECT * FROM reorder_policies WHERE sku_id = ? AND site_id = ?').get(k.id, s.id));
  });

  r.delete('/reorder-policies/:id', buyer, (req, res) => {
    const info = db.prepare('UPDATE reorder_policies SET active = 0 WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) throw notFound('Policy');
    res.json({ ok: true });
  });

  return r;
}

module.exports = { inventoryRouter };
