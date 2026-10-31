'use strict';
/**
 * Loads demo data through the real API (so every business rule is exercised).
 *   node scripts/seed.js [baseUrl]      default http://localhost:3000
 */
const assert = require('assert');
const { client, vendorProfile, DOCS, onboardVendor } = require('../test/helpers');

async function seed(base) {
  const api = client(base);
  const ok = (r, c = 200) => assert.strictEqual(r.status, c, JSON.stringify(r.body));

  const acme = await onboardVendor(api);
  const bolt = await onboardVendor(api, {
    legal_name: 'Bolt & Beam Hardware Inc', dba_name: null, tax_id: '23-4567890', bank_account_number: '4400112233', bank_routing_number: '011401533',
    primary_contact_email: 'sales@boltbeam.example', payment_terms: 'NET45',
  });

  // one vendor mid-review so the approval screens have something to show
  let r = await api('pat', 'POST', '/vendors', vendorProfile({ legal_name: 'Northwind Packaging Co', dba_name: null, tax_id: '34-5678901', bank_account_number: '9900112233', bank_routing_number: '021000021', primary_contact_email: 'orders@northwind.example' }));
  ok(r, 201); const nw = r.body.id;
  for (const d of DOCS) ok(await api('pat', 'POST', `/vendors/${nw}/documents`, d), 201);
  ok(await api('pat', 'POST', `/vendors/${nw}/submit`));
  const det = (await api('pat', 'GET', `/vendors/${nw}`)).body;
  for (const d of det.documents.slice(0, 3)) ok(await api('cara', 'POST', `/vendors/${nw}/documents/${d.id}/verify`, { decision: 'VERIFIED' }));
  for (const c of det.checks.filter((x) => !x.automated).slice(0, 4)) ok(await api('cara', 'POST', `/vendors/${nw}/checks/${c.check_type}`, { status: 'PASSED', evidence_ref: 'RPT-' + c.check_type }));

  ok(await api('pat', 'POST', '/vendors', { legal_name: 'Draft Logistics LLC', created_note: 'draft only' }), 201);

  ok(await api('wes', 'POST', '/sites', { code: 'WH1', name: 'San Jose Distribution Center', site_type: 'WAREHOUSE', city: 'San Jose', state: 'CA', country: 'US' }), 201);
  ok(await api('wes', 'POST', '/sites', { code: 'WH2', name: 'Reno Overflow Warehouse', site_type: 'WAREHOUSE', city: 'Reno', state: 'NV', country: 'US' }), 201);
  const sites = (await api('wes', 'GET', '/sites')).body; const wh1 = sites.find((s) => s.code === 'WH1').id;
  ok(await api('wes', 'POST', '/sites', { code: 'FL-BAY', name: 'Bay Area Service Fleet', site_type: 'FLEET', home_warehouse_id: wh1 }), 201);
  const fl = (await api('wes', 'GET', '/sites')).body.find((s) => s.code === 'FL-BAY').id;

  const loc = async (site, body) => { const x = await api('wes', 'POST', `/sites/${site}/locations`, body); ok(x, 201); return x.body.id; };
  const z = await loc(wh1, { code: 'WH1-Z1', loc_type: 'ZONE', name: 'Fasteners' });
  const a = await loc(wh1, { code: 'WH1-A01', loc_type: 'AISLE', parent_id: z });
  const rk = await loc(wh1, { code: 'WH1-A01-R1', loc_type: 'RACK', parent_id: a });
  for (const [i, c] of ['B1', 'B2', 'B3', 'B4'].entries()) await loc(wh1, { code: `WH1-A01-R1-${c}`, loc_type: 'BIN', parent_id: rk, pickable: true, pick_sequence: (i + 1) * 10 });
  const van = await loc(fl, { code: 'VAN-01', loc_type: 'VEHICLE', name: 'Service van 01' });
  await loc(fl, { code: 'VAN-01-REAR', loc_type: 'COMPARTMENT', parent_id: van, pickable: true });

  const mk = async (body) => { const x = await api('pat', 'POST', '/skus', body); ok(x, 201); return x.body; };
  const s1 = await mk({ description: 'M8 hex bolt, zinc, box of 100', category: 'Fasteners', barcode: '0123456789012', weight_kg: 1.2 });
  const s2 = await mk({ description: 'M8 nylon lock nut, box of 100', category: 'Fasteners', barcode: '0123456789029', weight_kg: 0.8 });
  const s3 = await mk({ description: 'Heavy-duty cable ties 300mm, bag of 500', category: 'Electrical', barcode: '0123456789036', weight_kg: 0.6 });
  const map = async (sku, vid, body) => ok(await api('pat', 'POST', `/skus/${sku.sku}/vendor-items`, { vendor_id: vid, ...body }), 201);
  await map(s1, acme, { vendor_item_number: 'ACME-BOLT-M8-12', vendor_uom: 'CS', pack_size: 12, unit_cost: 148, min_order_qty: 2, is_preferred: true });
  await map(s1, bolt, { vendor_item_number: 'BB-4411-M8', vendor_uom: 'CS', pack_size: 10, unit_cost: 152, lead_time_days: 5 });
  await map(s2, acme, { vendor_item_number: 'ACME-NUT-M8-24', vendor_uom: 'CS', pack_size: 24, unit_cost: 61 });
  await map(s3, bolt, { vendor_item_number: 'BB-CT-300-500', vendor_uom: 'EA', pack_size: 1, unit_cost: 7.4, min_order_qty: 10 });

  // Policies first: each raises its first PO immediately because stock is zero.
  ok(await api('pat', 'PUT', '/reorder-policies', { sku: s1.sku, site_id: wh1, min_qty: 240, max_qty: 1200 }));
  ok(await api('pat', 'PUT', '/reorder-policies', { sku: s2.sku, site_id: wh1, min_qty: 240, max_qty: 960 }));
  ok(await api('pat', 'PUT', '/reorder-policies', { sku: s3.sku, site_id: wh1, min_qty: 100, max_qty: 400 }));

  // receive the first two POs, leave the cable-tie PO open
  const pos = (await api('pat', 'GET', '/purchase-orders')).body;
  for (const po of pos) {
    const d = (await api('pat', 'GET', `/purchase-orders/${po.id}`)).body;
    if (d.lines[0].vendor_item_number.startsWith('BB-CT')) continue;
    ok(await api('wes', 'POST', `/purchase-orders/${po.id}/receive`, { lines: d.lines.map((l) => ({ vendor_item_number: l.vendor_item_number, qty: l.qty_ordered })) }));
  }
  const put = async (sku, to, qty) => ok(await api('wes', 'POST', '/transfers', { sku: sku.sku, from_location: 'WH1-RECV', to_location: to, qty }), 201);
  await put(s1, 'WH1-A01-R1-B1', 600); await put(s1, 'WH1-A01-R1-B2', 600);
  await put(s2, 'WH1-A01-R1-B3', 960);
  ok(await api('wes', 'POST', '/transfers', { sku: s2.sku, from_location: 'WH1-A01-R1-B3', to_location: 'VAN-01-REAR', qty: 48 }), 201);

  const order = async (customer, city, state, zip, lines) => {
    const x = await api('wes', 'POST', '/orders', { site_id: wh1, customer_name: customer, ship_to_line1: '100 Commerce Way', ship_to_city: city, ship_to_state: state, ship_to_postal_code: zip, ship_to_country: 'US', carrier: 'UPS', service_level: 'GROUND', lines });
    ok(x, 201); return x.body.id;
  };
  const o1 = await order('Contoso Construction', 'Austin', 'TX', '78701', [{ sku: s1.sku, qty: 300 }, { sku: s2.sku, qty: 120 }]);
  ok(await api('wes', 'POST', `/orders/${o1}/allocate`));
  await order('Fabrikam Electric', 'Denver', 'CO', '80202', [{ sku: s1.sku, qty: 50 }]);
  return { acme, bolt, nw };
}

module.exports = { seed };
if (require.main === module) {
  const base = process.argv[2] || 'http://localhost:3000';
  seed(base).then(() => console.log('Seeded demo data into', base)).catch((e) => { console.error(e); process.exit(1); });
}
