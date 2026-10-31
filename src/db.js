'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT, entity TEXT, entity_id INTEGER, action TEXT, detail TEXT
);

-- ===================== VENDORS =====================
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  vendor_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','UNDER_REVIEW','ACTIVE','REJECTED','SUSPENDED')),
  legal_name TEXT, dba_name TEXT, business_type TEXT,
  tax_id TEXT, country_of_incorporation TEXT, state_of_incorporation TEXT,
  registration_number TEXT, year_established INTEGER, duns_number TEXT, website TEXT,
  product_categories TEXT,
  primary_contact_name TEXT, primary_contact_title TEXT,
  primary_contact_email TEXT, primary_contact_phone TEXT,
  address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT,
  remit_line1 TEXT, remit_city TEXT, remit_state TEXT, remit_postal_code TEXT, remit_country TEXT,
  payment_terms TEXT, currency TEXT,
  bank_name TEXT, bank_account_last4 TEXT, bank_account_hash TEXT, bank_routing_last4 TEXT,
  insurance_provider TEXT, insurance_policy_number TEXT,
  insurance_coverage_amount REAL, insurance_expiry TEXT,
  business_license_number TEXT, business_license_expiry TEXT,
  lead_time_days_default INTEGER, min_order_value REAL,
  beneficial_owners TEXT,      -- JSON [{name, ownership_pct, country}]
  trade_references TEXT,       -- JSON [{company, contact, email, phone}]
  conflict_of_interest INTEGER, conflict_details TEXT,
  code_of_conduct_accepted INTEGER DEFAULT 0,
  anti_bribery_attested INTEGER DEFAULT 0,
  sanctions_attested INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_by TEXT, submitted_at TEXT,
  activated_at TEXT, status_reason TEXT
);

CREATE TABLE IF NOT EXISTS vendor_documents (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  reference_no TEXT, file_name TEXT, issued_on TEXT, expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  uploaded_by TEXT, verified_by TEXT, verified_at TEXT, notes TEXT,
  UNIQUE (vendor_id, doc_type)
);

CREATE TABLE IF NOT EXISTS vendor_checks (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,
  automated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PASSED','FAILED')),
  evidence_ref TEXT, notes TEXT, performed_by TEXT, performed_at TEXT,
  UNIQUE (vendor_id, check_type)
);

CREATE TABLE IF NOT EXISTS vendor_approvals (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('COMPLIANCE','FINANCE','PROCUREMENT')),
  seq INTEGER NOT NULL,
  decision TEXT NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  approver TEXT, comments TEXT, decided_at TEXT,
  UNIQUE (vendor_id, stage)
);

-- ===================== SITES / LOCATIONS =====================
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  site_type TEXT NOT NULL CHECK (site_type IN ('WAREHOUSE','FLEET')),
  home_warehouse_id INTEGER REFERENCES sites(id),
  address TEXT, city TEXT, state TEXT, country TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (site_type = 'FLEET' OR home_warehouse_id IS NULL)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  parent_id INTEGER REFERENCES locations(id),
  code TEXT NOT NULL,
  name TEXT,
  loc_type TEXT NOT NULL CHECK (loc_type IN
    ('ZONE','AISLE','RACK','SHELF','BIN','DOCK','STAGING','PACK_STATION','VEHICLE','COMPARTMENT')),
  pickable INTEGER NOT NULL DEFAULT 0,
  pick_sequence INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  UNIQUE (site_id, code)
);

-- ===================== ITEMS =====================
CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  category TEXT, base_uom TEXT NOT NULL DEFAULT 'EA',
  barcode TEXT UNIQUE,
  weight_kg REAL, length_cm REAL, width_cm REAL, height_cm REAL,
  hazmat INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS vendor_items (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  vendor_item_number TEXT NOT NULL,
  vendor_uom TEXT NOT NULL DEFAULT 'EA',
  pack_size INTEGER NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
  min_order_qty INTEGER NOT NULL DEFAULT 1 CHECK (min_order_qty > 0),
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (vendor_id, vendor_item_number),
  UNIQUE (vendor_id, sku_id)
);
-- at most one preferred vendor item per SKU
CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_items_preferred
  ON vendor_items(sku_id) WHERE is_preferred = 1;

-- ===================== STOCK =====================
CREATE TABLE IF NOT EXISTS stock (
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_allocated INTEGER NOT NULL DEFAULT 0 CHECK (qty_allocated >= 0),
  cycle_count_flag INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sku_id, location_id),
  CHECK (qty_allocated <= qty_on_hand)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  move_type TEXT NOT NULL,
  ref_type TEXT, ref_id INTEGER, actor TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS reorder_policies (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  min_qty INTEGER NOT NULL CHECK (min_qty >= 0),
  max_qty INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (sku_id, site_id),
  CHECK (max_qty > min_qty)
);

-- ===================== PURCHASING =====================
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  source TEXT NOT NULL DEFAULT 'MANUAL',
  currency TEXT, payment_terms TEXT, expected_date TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), notes TEXT
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  vendor_item_id INTEGER NOT NULL REFERENCES vendor_items(id),
  vendor_item_number TEXT NOT NULL,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  description TEXT,
  qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received INTEGER NOT NULL DEFAULT 0,
  pack_size INTEGER NOT NULL DEFAULT 1,
  vendor_uom TEXT, unit_cost REAL NOT NULL,
  UNIQUE (po_id, line_no),
  CHECK (qty_received >= 0 AND qty_received <= qty_ordered)
);

CREATE TABLE IF NOT EXISTS po_receipts (
  id INTEGER PRIMARY KEY,
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  qty_vendor_uom INTEGER NOT NULL, qty_base INTEGER NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  received_by TEXT, ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ===================== FULFILLMENT =====================
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  customer_name TEXT NOT NULL,
  ship_to_line1 TEXT NOT NULL, ship_to_city TEXT NOT NULL, ship_to_state TEXT,
  ship_to_postal_code TEXT NOT NULL, ship_to_country TEXT NOT NULL,
  carrier TEXT, service_level TEXT, priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN
    ('NEW','PARTIALLY_ALLOCATED','ALLOCATED','PICKING','PICKED','PACKING','PACKED',
     'PARTIALLY_SHIPPED','SHIPPED','CANCELLED')),
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS so_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_allocated INTEGER NOT NULL DEFAULT 0,
  qty_picked INTEGER NOT NULL DEFAULT 0,
  qty_packed INTEGER NOT NULL DEFAULT 0,
  qty_shipped INTEGER NOT NULL DEFAULT 0,
  UNIQUE (order_id, line_no),
  CHECK (qty_shipped <= qty_packed AND qty_packed <= qty_picked
         AND qty_picked <= qty_allocated AND qty_allocated <= qty_ordered)
);

CREATE TABLE IF NOT EXISTS pick_lists (
  id INTEGER PRIMARY KEY,
  pick_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETE')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), completed_at TEXT
);

CREATE TABLE IF NOT EXISTS pick_tasks (
  id INTEGER PRIMARY KEY,
  pick_list_id INTEGER NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
  so_line_id INTEGER NOT NULL REFERENCES so_lines(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_to_pick INTEGER NOT NULL CHECK (qty_to_pick > 0),
  qty_picked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PICKED','SHORT')),
  pick_seq INTEGER NOT NULL DEFAULT 0,
  picked_by TEXT, picked_at TEXT, short_reason TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  shipment_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  carrier TEXT NOT NULL, service_level TEXT, tracking_number TEXT NOT NULL,
  bol_number TEXT NOT NULL, total_weight_kg REAL,
  shipped_by TEXT, shipped_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cartons (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  carton_number TEXT NOT NULL UNIQUE,
  sscc TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','SHIPPED')),
  weight_kg REAL, length_cm REAL, width_cm REAL, height_cm REAL,
  shipment_id INTEGER REFERENCES shipments(id),
  packed_by TEXT, closed_at TEXT
);

CREATE TABLE IF NOT EXISTS carton_items (
  id INTEGER PRIMARY KEY,
  carton_id INTEGER NOT NULL REFERENCES cartons(id) ON DELETE CASCADE,
  so_line_id INTEGER NOT NULL REFERENCES so_lines(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  qty INTEGER NOT NULL CHECK (qty > 0)
);
`;

const depth = new WeakMap();

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  depth.set(db, 0);
  return db;
}

/** Run fn in a transaction. Nested calls join the outer transaction. */
function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) { depth.set(db, d + 1); try { return fn(); } finally { depth.set(db, depth.get(db) - 1); } }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

function nextCounter(db, name) {
  return db.prepare(
    `INSERT INTO counters(name, value) VALUES(?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
  ).get(name).value;
}

function audit(db, actor, entity, entityId, action, detail) {
  db.prepare('INSERT INTO audit_log(actor, entity, entity_id, action, detail) VALUES (?,?,?,?,?)')
    .run(actor || 'system', entity, entityId ?? null, action,
      detail === undefined ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (what) => new HttpError(404, `${what} not found`);
const conflict = (msg, details) => new HttpError(409, msg, details);

module.exports = { openDb, tx, nextCounter, audit, HttpError, bad, notFound, conflict };
