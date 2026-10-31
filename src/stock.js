'use strict';
/** Low-level stock ledger operations shared by receiving, transfers, picking and shipping. */
const { bad, conflict } = require('./db');

function getRow(db, skuId, locId) {
  return db.prepare('SELECT * FROM stock WHERE sku_id = ? AND location_id = ?').get(skuId, locId);
}

function ledger(db, { skuId, from = null, to = null, qty, type, refType = null, refId = null, actor, note = null }) {
  db.prepare(`INSERT INTO stock_movements (sku_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, actor, note)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(skuId, from, to, qty, type, refType, refId, actor || 'system', note);
}

/** Add on-hand stock (optionally already reserved). */
function addStock(db, skuId, locId, qty, { allocated = 0 } = {}) {
  db.prepare(`INSERT INTO stock (sku_id, location_id, qty_on_hand, qty_allocated) VALUES (?,?,?,?)
              ON CONFLICT(sku_id, location_id) DO UPDATE SET
              qty_on_hand = qty_on_hand + excluded.qty_on_hand,
              qty_allocated = qty_allocated + excluded.qty_allocated`).run(skuId, locId, qty, allocated);
}

/** Remove stock; `fromAllocated` consumes reserved units first (picking / shipping). */
function removeStock(db, skuId, locId, qty, { fromAllocated = false } = {}) {
  const row = getRow(db, skuId, locId);
  const avail = row ? row.qty_on_hand - row.qty_allocated : 0;
  if (!row || (fromAllocated ? row.qty_allocated < qty : avail < qty))
    throw conflict(`Insufficient ${fromAllocated ? 'allocated' : 'available'} stock at location`, { sku_id: skuId, location_id: locId, requested: qty, available: fromAllocated ? row?.qty_allocated ?? 0 : avail });
  db.prepare(`UPDATE stock SET qty_on_hand = qty_on_hand - ?, qty_allocated = qty_allocated - ? WHERE sku_id = ? AND location_id = ?`)
    .run(qty, fromAllocated ? qty : 0, skuId, locId);
}

function reserve(db, skuId, locId, qty) {
  const row = getRow(db, skuId, locId);
  if (!row || row.qty_on_hand - row.qty_allocated < qty) throw conflict('Not enough available stock to reserve');
  db.prepare('UPDATE stock SET qty_allocated = qty_allocated + ? WHERE sku_id = ? AND location_id = ?').run(qty, skuId, locId);
}

function release(db, skuId, locId, qty) {
  const row = getRow(db, skuId, locId);
  if (!row || row.qty_allocated < qty) throw conflict('Cannot release more than is reserved');
  db.prepare('UPDATE stock SET qty_allocated = qty_allocated - ? WHERE sku_id = ? AND location_id = ?').run(qty, skuId, locId);
}

/** Available (on-hand minus reserved) for a SKU across every location in a site. */
function availableAtSite(db, skuId, siteId) {
  return db.prepare(`SELECT COALESCE(SUM(s.qty_on_hand - s.qty_allocated), 0) AS n
    FROM stock s JOIN locations l ON l.id = s.location_id WHERE s.sku_id = ? AND l.site_id = ?`).get(skuId, siteId).n;
}

function onHandAtSite(db, skuId, siteId) {
  return db.prepare(`SELECT COALESCE(SUM(s.qty_on_hand), 0) AS n
    FROM stock s JOIN locations l ON l.id = s.location_id WHERE s.sku_id = ? AND l.site_id = ?`).get(skuId, siteId).n;
}

/** Base units on open purchase order lines that are still to arrive at a site. */
function onOrderAtSite(db, skuId, siteId) {
  return db.prepare(`SELECT COALESCE(SUM((pl.qty_ordered - pl.qty_received) * pl.pack_size), 0) AS n
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE pl.sku_id = ? AND po.site_id = ? AND po.status IN ('OPEN','PARTIALLY_RECEIVED')`).get(skuId, siteId).n;
}

function posInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} must be a positive whole number`);
  return n;
}

module.exports = { getRow, ledger, addStock, removeStock, reserve, release, availableAtSite, onHandAtSite, onOrderAtSite, posInt };
