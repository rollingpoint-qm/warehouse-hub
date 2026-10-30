'use strict';
const path = require('path');
const express = require('express');
const { openDb, HttpError } = require('./db');
const { identity } = require('./auth');
const { vendorRouter } = require('./vendors');
const { inventoryRouter } = require('./inventory');
const { procurementRouter, runReorder } = require('./procurement');
const { fulfillmentRouter } = require('./fulfillment');

function createApp(dbFile = process.env.DB_FILE || ':memory:') {
  const db = openDb(dbFile);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Any stock change that can lower availability re-evaluates min/max for that SKU + warehouse.
  const hooks = { afterStockChange: (skuId, siteId, actor) => runReorder(db, actor, { skuId, siteId }) };

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use(identity);
  api.use('/vendors', vendorRouter(db));
  api.use(inventoryRouter(db, hooks));
  api.use(procurementRouter(db));
  api.use(fulfillmentRouter(db, hooks));

  api.get('/summary', (req, res) => {
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    res.json({
      vendors: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM vendors GROUP BY status').all().map((r) => [r.status, r.n])),
      purchase_orders: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM purchase_orders GROUP BY status').all().map((r) => [r.status, r.n])),
      orders: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM sales_orders GROUP BY status').all().map((r) => [r.status, r.n])),
      skus: count('SELECT COUNT(*) AS n FROM skus'),
      sites: count('SELECT COUNT(*) AS n FROM sites'),
      units_on_hand: count('SELECT COALESCE(SUM(qty_on_hand),0) AS n FROM stock'),
      cycle_count_flags: count('SELECT COUNT(*) AS n FROM stock WHERE cycle_count_flag = 1'),
      open_picks: count("SELECT COUNT(*) AS n FROM pick_lists WHERE status != 'COMPLETE'"),
    });
  });

  api.get('/audit', (req, res) => {
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err && /constraint failed|UNIQUE|FOREIGN KEY|CHECK/i.test(String(err.message)))
      return res.status(409).json({ error: 'Data constraint violated', details: String(err.message) });
    if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'warehouse.db');
  const { app } = createApp(file);
  app.listen(port, () => console.log(`Warehouse Hub on http://localhost:${port}  (db: ${file})`));
}

module.exports = { createApp };
