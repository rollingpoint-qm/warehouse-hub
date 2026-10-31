'use strict';
/** End-to-end test: boots the real app on an in-memory DB and drives every requirement through the HTTP API. */
const assert = require('assert');
const { createApp } = require('../src/server');
const { client, vendorProfile, onboardVendor, future } = require('./helpers');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ok   ' + name); }
  catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}
const ok = (r, code = 200) => assert.strictEqual(r.status, code, `expected ${code} got ${r.status}: ${JSON.stringify(r.body)}`);
const fail = (r, code) => assert.strictEqual(r.status, code, `expected ${code} got ${r.status}: ${JSON.stringify(r.body)}`);

function ssccValid(s) {
  if (!/^\d{18}$/.test(s)) return false;
  let sum = 0; for (let i = 0; i < 17; i++) sum += Number(s[16 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[17]);
}

(async () => {
  const { app, db } = createApp(':memory:');
  const server = app.listen(0);
  const api = client(`http://localhost:${server.address().port}`);
  const S = {};   // shared state across steps

  console.log('\n1) VENDOR ONBOARDING + BACKGROUND CHECK + APPROVAL');
  await step('role gate: warehouse user cannot create vendors', async () => fail(await api('wes', 'POST', '/vendors', { legal_name: 'x' }), 403));
  await step('create DRAFT vendor with partial data', async () => {
    const r = await api('pat', 'POST', '/vendors', { legal_name: 'Half Done Co' }); ok(r, 201);
    S.draft = r.body.id; assert.strictEqual(r.body.status, 'DRAFT'); assert.match(r.body.vendor_code, /^V-\d{5}$/);
  });
  await step('submit incomplete application is rejected with a field-level list', async () => {
    const r = await api('pat', 'POST', `/vendors/${S.draft}/submit`); fail(r, 400);
    assert.ok(r.body.details.length >= 15, 'expected many missing items');
    assert.ok(r.body.details.some((e) => e.field === 'tax_id'));
    assert.ok(r.body.details.some((e) => e.message.includes('Required document missing')));
  });
  await step('invalid routing number fails ABA checksum', async () => fail(await api('pat', 'PATCH', `/vendors/${S.draft}`, { country_of_incorporation: 'US', bank_routing_number: '123456789' }), 400));
  await step('insurance expiring in <30 days blocks submission', async () => {
    const r = await api('pat', 'POST', '/vendors', vendorProfile({ legal_name: 'Soon Expiring Inc', tax_id: '98-7654321', bank_account_number: '5550001111', insurance_expiry: future(10) })); ok(r, 201);
    const s = await api('pat', 'POST', `/vendors/${r.body.id}/submit`); fail(s, 400);
    assert.ok(s.body.details.some((e) => e.field === 'insurance_expiry'));
  });
  await step('full onboarding: docs -> submit -> verify docs -> 10 checks -> 3 approvals -> ACTIVE', async () => {
    S.vendor = await onboardVendor(api);
    const v = (await api('pat', 'GET', `/vendors/${S.vendor}`)).body;
    assert.strictEqual(v.vendor.status, 'ACTIVE'); assert.ok(v.vendor.activated_at);
    assert.strictEqual(v.checks.length, 10); assert.ok(v.checks.every((c) => c.status === 'PASSED'));
    assert.strictEqual(v.vendor.tax_id, undefined, 'tax id must not be returned'); assert.ok(v.vendor.tax_id_masked.endsWith('6789'));
    assert.strictEqual(v.vendor.bank_account_last4, '6789'); assert.strictEqual(v.vendor.bank_account_hash, undefined);
  });
  await step('approval gates: out of order, wrong role, submitter, early approval', async () => {
    const id = (await api('pat', 'POST', '/vendors', vendorProfile({ legal_name: 'Gate Test Ltd', tax_id: '55-5555555', bank_account_number: '777700001234' }))).body.id;
    for (const d of require('./helpers').DOCS) await api('pat', 'POST', `/vendors/${id}/documents`, d);
    ok(await api('pat', 'POST', `/vendors/${id}/submit`));
    fail(await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'APPROVED' }), 409);          // nothing verified yet
    fail(await api('fin', 'POST', `/vendors/${id}/approvals/FINANCE`, { decision: 'APPROVED' }), 409);              // compliance first
    fail(await api('cara', 'POST', `/vendors/${id}/approvals/FINANCE`, { decision: 'APPROVED' }), 403);             // wrong role
    fail(await api('pat', 'POST', `/vendors/${id}/checks/CREDIT_CHECK`, { status: 'PASSED', evidence_ref: 'x' }), 403); // procurement cannot vet
    const d = (await api('pat', 'GET', `/vendors/${id}`)).body;
    fail(await api('cara', 'POST', `/vendors/${id}/checks/CREDIT_CHECK`, { status: 'PASSED' }), 400);               // evidence required
    fail(await api('cara', 'POST', `/vendors/${id}/checks/CREDIT_CHECK`, { status: 'FAILED', evidence_ref: 'R1' }), 400); // notes required on fail
    assert.ok(d.blockers.length > 10);
    // a failed check blocks compliance approval and activation
    for (const doc of d.documents) ok(await api('cara', 'POST', `/vendors/${id}/documents/${doc.id}/verify`, { decision: 'VERIFIED' }));
    for (const c of d.checks.filter((x) => !x.automated)) ok(await api('cara', 'POST', `/vendors/${id}/checks/${c.check_type}`, c.check_type === 'SANCTIONS_SCREENING' ? { status: 'FAILED', evidence_ref: 'HIT-1', notes: 'Possible watch-list match' } : { status: 'PASSED', evidence_ref: 'ok' }));
    const a = await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'APPROVED' }); fail(a, 409);
    assert.ok(a.body.details.some((x) => x.includes('SANCTIONS_SCREENING')));
    fail(await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'REJECTED' }), 400);         // comments required
    const rej = await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'REJECTED', comments: 'Sanctions hit' }); ok(rej);
    assert.strictEqual(rej.body.status, 'REJECTED');
    ok(await api('pat', 'POST', `/vendors/${id}/reopen`));    // can re-apply after remediation
  });
  await step('segregation of duties: submitter cannot approve; one person cannot approve two stages', async () => {
    const id = (await api('paula', 'POST', '/vendors', vendorProfile({ legal_name: 'SoD Test GmbH', tax_id: '44-4444444', bank_account_number: '888800005678' }))).body.id;
    for (const d of require('./helpers').DOCS) await api('paula', 'POST', `/vendors/${id}/documents`, d);
    ok(await api('paula', 'POST', `/vendors/${id}/submit`));
    const d = (await api('paula', 'GET', `/vendors/${id}`)).body;
    for (const doc of d.documents) ok(await api('cara', 'POST', `/vendors/${id}/documents/${doc.id}/verify`, { decision: 'VERIFIED' }));
    for (const c of d.checks.filter((x) => !x.automated)) ok(await api('cara', 'POST', `/vendors/${id}/checks/${c.check_type}`, { status: 'PASSED', evidence_ref: 'ok' }));
    ok(await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'APPROVED' }));
    ok(await api('fin', 'POST', `/vendors/${id}/approvals/FINANCE`, { decision: 'APPROVED' }));
    fail(await api('paula', 'POST', `/vendors/${id}/approvals/PROCUREMENT`, { decision: 'APPROVED' }), 409);   // she submitted it
    ok(await api('pat', 'POST', `/vendors/${id}/approvals/PROCUREMENT`, { decision: 'APPROVED' }));
  });
  await step('duplicate vendor screen flags shared tax ID / bank account', async () => {
    const r = await api('pat', 'POST', '/vendors', vendorProfile({ legal_name: 'Totally Different Name', dba_name: null })); ok(r, 201);
    for (const d of require('./helpers').DOCS) await api('pat', 'POST', `/vendors/${r.body.id}/documents`, d);
    ok(await api('pat', 'POST', `/vendors/${r.body.id}/submit`));
    const d = (await api('pat', 'GET', `/vendors/${r.body.id}`)).body;
    const dup = d.checks.find((c) => c.check_type === 'DUPLICATE_VENDOR_SCREEN');
    assert.strictEqual(dup.status, 'FAILED'); assert.match(dup.notes, /Tax ID/); assert.match(dup.notes, /bank account/);
  });
  await step('PO eligibility blocked for a vendor that is not ACTIVE', async () => {
    const r = await api('pat', 'POST', '/purchase-orders', { vendor_id: S.draft, site_id: 1, lines: [{ vendor_item_number: 'X', qty: 1 }] });
    fail(r, 409);
  });

  console.log('\n2) INVENTORY STRUCTURE: warehouses, fleets, sublocations, SKU <-> vendor item number');
  await step('create warehouse (auto dock + staging) and fleet linked to it', async () => {
    let r = await api('wes', 'POST', '/sites', { code: 'WH1', name: 'San Jose DC', site_type: 'WAREHOUSE', city: 'San Jose' }); ok(r, 201); S.wh = r.body.id;
    r = await api('wes', 'POST', '/sites', { code: 'WH2', name: 'Reno DC', site_type: 'WAREHOUSE' }); ok(r, 201); S.wh2 = r.body.id;
    r = await api('wes', 'POST', '/sites', { code: 'FL1', name: 'Bay Area Fleet', site_type: 'FLEET', home_warehouse_id: S.wh }); ok(r, 201); S.fl = r.body.id;
    fail(await api('wes', 'POST', '/sites', { code: 'FL2', name: 'Orphan fleet', site_type: 'FLEET' }), 400);
    fail(await api('wes', 'POST', '/sites', { code: 'WH1', name: 'dup', site_type: 'WAREHOUSE' }), 409);
    const site = (await api('wes', 'GET', `/sites/${S.wh}`)).body;
    assert.deepStrictEqual(site.locations.map((l) => l.loc_type).sort(), ['DOCK', 'STAGING']);
    assert.strictEqual(site.fleets.length, 1);
  });
  await step('nested sublocations (zone > aisle > rack > bin) and vehicle > compartment', async () => {
    const mk = async (site, body) => { const r = await api('wes', 'POST', `/sites/${site}/locations`, body); ok(r, 201); return r.body; };
    const z = await mk(S.wh, { code: 'WH1-Z1', loc_type: 'ZONE' });
    const a = await mk(S.wh, { code: 'WH1-A01', loc_type: 'AISLE', parent_id: z.id });
    const rk = await mk(S.wh, { code: 'WH1-A01-R1', loc_type: 'RACK', parent_id: a.id });
    const b1 = await mk(S.wh, { code: 'WH1-A01-R1-B1', loc_type: 'BIN', parent_id: rk.id, pickable: true, pick_sequence: 10 });
    await mk(S.wh, { code: 'WH1-A01-R1-B2', loc_type: 'BIN', parent_id: rk.id, pickable: true, pick_sequence: 20 });
    assert.strictEqual(b1.path, 'WH1-Z1/WH1-A01/WH1-A01-R1/WH1-A01-R1-B1');
    const van = await mk(S.fl, { code: 'VAN-01', loc_type: 'VEHICLE' });
    await mk(S.fl, { code: 'VAN-01-REAR', loc_type: 'COMPARTMENT', parent_id: van.id, pickable: true });
    fail(await api('wes', 'POST', `/sites/${S.wh}/locations`, { code: 'WH1-Z1', loc_type: 'ZONE' }), 409);
    fail(await api('wes', 'POST', `/sites/${S.wh}/locations`, { code: 'BAD', loc_type: 'BIN', parent_id: van.id }), 400);   // parent in a different site
  });
  await step('SKUs get unique auto-generated numbers; duplicates are rejected', async () => {
    let r = await api('pat', 'POST', '/skus', { description: 'M8 Hex Bolt (box)', barcode: '0123456789012', weight_kg: 1.2 }); ok(r, 201); S.skuA = r.body;
    r = await api('pat', 'POST', '/skus', { description: 'M8 Nut (box)', barcode: '0123456789029', weight_kg: 0.8 }); ok(r, 201); S.skuB = r.body;
    assert.match(S.skuA.sku, /^SKU-\d{6}$/); assert.notStrictEqual(S.skuA.sku, S.skuB.sku);
    fail(await api('pat', 'POST', '/skus', { description: 'dup barcode', barcode: '0123456789012' }), 409);
    r = await api('pat', 'POST', '/skus', { description: 'Custom', sku: 'cust-0001' }); ok(r, 201); assert.strictEqual(r.body.sku, 'CUST-0001');
    fail(await api('pat', 'POST', '/skus', { description: 'dup sku', sku: 'CUST-0001' }), 409);
    fail(await api('pat', 'POST', '/skus', { description: 'bad', sku: 'a b' }), 400);
  });
  await step('map SKU to vendor item number (pack size, cost, MOQ); enforce uniqueness and vendor eligibility', async () => {
    let r = await api('pat', 'POST', `/skus/${S.skuA.sku}/vendor-items`, { vendor_id: S.vendor, vendor_item_number: 'ACME-BOLT-M8-12', pack_size: 12, unit_cost: 18.5, min_order_qty: 2, vendor_uom: 'BX' }); ok(r, 201);
    assert.strictEqual(r.body.is_preferred, 1);
    r = await api('pat', 'POST', `/skus/${S.skuB.sku}/vendor-items`, { vendor_id: S.vendor, vendor_item_number: 'ACME-NUT-M8-50', pack_size: 50, unit_cost: 9, vendor_uom: 'BX' }); ok(r, 201);
    fail(await api('pat', 'POST', `/skus/${S.skuB.sku}/vendor-items`, { vendor_id: S.vendor, vendor_item_number: 'ACME-BOLT-M8-12', unit_cost: 1 }), 409);   // dup vendor item number
    fail(await api('pat', 'POST', `/skus/${S.skuB.sku}/vendor-items`, { vendor_id: S.draft, vendor_item_number: 'NOPE-1', unit_cost: 1 }), 409);              // vendor not active
    const k = (await api('pat', 'GET', `/skus/${S.skuA.sku}`)).body;
    assert.strictEqual(k.vendor_items[0].vendor_item_number, 'ACME-BOLT-M8-12'); assert.strictEqual(k.vendor_items[0].legal_name, 'Acme Industrial Supply LLC');
  });

  console.log('\n3) MIN/MAX REORDER -> PURCHASE ORDER ON VENDOR ITEM NUMBER');
  await step('setting min/max below current stock immediately raises an AUTO PO in vendor pack units', async () => {
    const r = await api('pat', 'PUT', '/reorder-policies', { sku: S.skuA.sku, site_id: S.wh, min_qty: 20, max_qty: 100 }); ok(r);
    const pos = (await api('pat', 'GET', '/purchase-orders')).body;
    assert.strictEqual(pos.length, 1); S.po1 = pos[0];
    assert.strictEqual(pos[0].source, 'AUTO_REORDER'); assert.strictEqual(pos[0].status, 'OPEN');
    const d = (await api('pat', 'GET', `/purchase-orders/${S.po1.id}`)).body;
    assert.strictEqual(d.lines.length, 1);
    assert.strictEqual(d.lines[0].vendor_item_number, 'ACME-BOLT-M8-12');       // PO is raised on the vendor's number...
    assert.strictEqual(d.lines[0].sku, S.skuA.sku);                              // ...and still ties back to our SKU
    assert.strictEqual(d.lines[0].qty_ordered, 9);                               // ceil(100 / 12) boxes
    assert.strictEqual(d.total_amount, 9 * 18.5);
  });
  await step('no duplicate PO while one is already open (on-order counted in position)', async () => {
    const run = await api('pat', 'POST', '/reorder/run'); ok(run); assert.strictEqual(run.body.created.length, 0);
    const st = (await api('pat', 'GET', '/reorder/status')).body.find((x) => x.sku === S.skuA.sku);
    assert.strictEqual(st.on_order, 108); assert.strictEqual(st.state, 'ON_ORDER');
  });
  await step('receiving: over-receipt rejected, partial then full, stock lands on dock', async () => {
    fail(await api('wes', 'POST', `/purchase-orders/${S.po1.id}/receive`, { lines: [{ vendor_item_number: 'ACME-BOLT-M8-12', qty: 10 }] }), 409);
    fail(await api('wes', 'POST', `/purchase-orders/${S.po1.id}/receive`, { lines: [{ vendor_item_number: 'WRONG', qty: 1 }] }), 400);
    let r = await api('wes', 'POST', `/purchase-orders/${S.po1.id}/receive`, { lines: [{ vendor_item_number: 'ACME-BOLT-M8-12', qty: 4 }] }); ok(r);
    assert.strictEqual(r.body.status, 'PARTIALLY_RECEIVED');
    r = await api('wes', 'POST', `/purchase-orders/${S.po1.id}/receive`, { lines: [{ vendor_item_number: 'ACME-BOLT-M8-12', qty: 5 }] }); ok(r);
    assert.strictEqual(r.body.status, 'RECEIVED');
    const st = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body;
    assert.strictEqual(st.length, 1); assert.strictEqual(st[0].qty_on_hand, 108); assert.strictEqual(st[0].location_code, 'WH1-RECV');
    fail(await api('wes', 'POST', `/purchase-orders/${S.po1.id}/cancel`, { reason: 'x' }), 403);
  });
  await step('put-away from dock into bins', async () => {
    ok(await api('wes', 'POST', '/transfers', { sku: S.skuA.sku, from_location: 'WH1-RECV', to_location: 'WH1-A01-R1-B1', qty: 60 }), 201);
    ok(await api('wes', 'POST', '/transfers', { sku: S.skuA.sku, from_location: 'WH1-RECV', to_location: 'WH1-A01-R1-B2', qty: 48 }), 201);
    fail(await api('wes', 'POST', '/transfers', { sku: S.skuA.sku, from_location: 'WH1-RECV', to_location: 'WH1-A01-R1-B2', qty: 1 }), 409);   // dock is empty
  });
  await step('manual PO must use vendor item numbers and respect MOQ', async () => {
    fail(await api('pat', 'POST', '/purchase-orders', { vendor_id: S.vendor, site_id: S.wh, lines: [{ vendor_item_number: S.skuA.sku, qty: 5 }] }), 400);  // our SKU is not a vendor number
    fail(await api('pat', 'POST', '/purchase-orders', { vendor_id: S.vendor, site_id: S.wh, lines: [{ vendor_item_number: 'ACME-BOLT-M8-12', qty: 1 }] }), 400); // MOQ 2
    const r = await api('pat', 'POST', '/purchase-orders', { vendor_id: S.vendor, site_id: S.wh, lines: [{ vendor_item_number: 'ACME-NUT-M8-50', qty: 3 }], notes: 'manual' }); ok(r, 201);
    ok(await api('pat', 'POST', `/purchase-orders/${r.body.id}/cancel`, { reason: 'test' }));
  });

  console.log('\n4) PICK / PACK / SHIP');
  await step('create order and allocate: pick path follows bin sequence', async () => {
    let r = await api('wes', 'POST', '/orders', { site_id: S.wh, customer_name: 'Contoso', ship_to_line1: '1 Main St', ship_to_city: 'Austin', ship_to_state: 'TX', ship_to_postal_code: '78701', ship_to_country: 'US', carrier: 'UPS', service_level: 'GROUND', lines: [{ sku: S.skuA.sku, qty: 30 }] });
    ok(r, 201); S.so1 = r.body.id; assert.strictEqual(r.body.status, 'NEW');
    r = await api('wes', 'POST', `/orders/${S.so1}/allocate`); ok(r);
    assert.strictEqual(r.body.pick_list.tasks, 1); assert.strictEqual(r.body.order.status, 'ALLOCATED');
    S.pl1 = r.body.order.pick_lists[0]; assert.strictEqual(S.pl1.tasks[0].location_code, 'WH1-A01-R1-B1');
    const st = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body.find((x) => x.location_code === 'WH1-A01-R1-B1');
    assert.strictEqual(st.qty_allocated, 30); assert.strictEqual(st.qty_available, 30);
  });
  await step('pick requires correct location + item scans', async () => {
    const t = S.pl1.tasks[0];
    fail(await api('wes', 'POST', `/pick-tasks/${t.id}/confirm`, { scan_location: 'WH1-A01-R1-B2', scan_item: S.skuA.barcode, qty_picked: 30 }), 409);
    fail(await api('wes', 'POST', `/pick-tasks/${t.id}/confirm`, { scan_location: 'WH1-A01-R1-B1', scan_item: S.skuB.barcode, qty_picked: 30 }), 409);
    fail(await api('wes', 'POST', `/pick-tasks/${t.id}/confirm`, { scan_location: 'WH1-A01-R1-B1', scan_item: S.skuA.barcode, qty_picked: 31 }), 400);
    const r = await api('wes', 'POST', `/pick-tasks/${t.id}/confirm`, { scan_location: 'WH1-A01-R1-B1', scan_item: S.skuA.barcode, qty_picked: 30 }); ok(r);
    assert.strictEqual(r.body.order_status, 'PICKED');
    const stock = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body;
    assert.strictEqual(stock.find((x) => x.location_code === 'WH1-A01-R1-B1').qty_on_hand, 30);   // bin dropped immediately
    const stg = stock.find((x) => x.location_code === 'WH1-STAGE'); assert.strictEqual(stg.qty_on_hand, 30); assert.strictEqual(stg.qty_allocated, 30);
  });
  await step('pack: cannot ship before packing; item/qty verification; closing needs weight + dims; SSCC-18 assigned', async () => {
    fail(await api('wes', 'POST', `/orders/${S.so1}/ship`, { carrier: 'UPS', tracking_number: '1Z999' }), 409);
    let r = await api('wes', 'POST', `/orders/${S.so1}/cartons`); ok(r, 201); S.c1 = r.body.id;
    fail(await api('wes', 'POST', `/cartons/${S.c1}/items`, { scan_item: S.skuB.barcode, qty: 1 }), 409);        // not on order
    fail(await api('wes', 'POST', `/cartons/${S.c1}/items`, { scan_item: S.skuA.barcode, qty: 31 }), 409);       // more than picked
    ok(await api('wes', 'POST', `/cartons/${S.c1}/items`, { scan_item: S.skuA.barcode, qty: 30 }), 201);
    fail(await api('wes', 'POST', `/cartons/${S.c1}/close`, { length_cm: 30, width_cm: 20, height_cm: 15 }), 400);   // no weight
    r = await api('wes', 'POST', `/cartons/${S.c1}/close`, { weight_kg: 36.5, length_cm: 40, width_cm: 30, height_cm: 25 }); ok(r);
    assert.ok(ssccValid(r.body.carton.sscc), 'SSCC check digit invalid: ' + r.body.carton.sscc);
    assert.strictEqual(r.body.carton.status, 'CLOSED');
    const so = (await api('wes', 'GET', `/orders/${S.so1}`)).body; assert.strictEqual(so.status, 'PACKED');
    const label = (await api('wes', 'GET', `/cartons/${S.c1}/label`)).body;
    assert.strictEqual(label.gs1_128_data, '00' + r.body.carton.sscc); assert.strictEqual(label.ship_to.city, 'Austin');
  });
  await step('ship: tracking required; shipment + BOL created; stock leaves staging; order SHIPPED', async () => {
    fail(await api('wes', 'POST', `/orders/${S.so1}/ship`, { carrier: 'UPS' }), 400);
    const r = await api('wes', 'POST', `/orders/${S.so1}/ship`, { carrier: 'UPS', service_level: 'GROUND', tracking_number: '1Z999AA10123456784' }); ok(r, 201);
    assert.match(r.body.shipment.bol_number, /^BOL-\d{4}-\d{6}$/); assert.strictEqual(r.body.order_status, 'SHIPPED');
    const stock = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body;
    assert.strictEqual(stock.find((x) => x.location_code === 'WH1-STAGE').qty_on_hand, 0);
    assert.strictEqual(stock.reduce((t, x) => t + x.qty_on_hand, 0), 78);
    fail(await api('wes', 'POST', `/orders/${S.so1}/ship`, { carrier: 'UPS', tracking_number: 'again' }), 409);       // nothing left to ship
    const slip = (await api('wes', 'GET', `/orders/${S.so1}/packing-slip`)).body; assert.strictEqual(slip.lines[0].qty_backordered, 0);
  });
  await step('ALLOCATION TRIGGERS REORDER: stock falls below min -> PO auto-created', async () => {
    let r = await api('wes', 'POST', '/orders', { site_id: S.wh, customer_name: 'Fabrikam', ship_to_line1: '2 Oak Ave', ship_to_city: 'Denver', ship_to_state: 'CO', ship_to_postal_code: '80202', ship_to_country: 'US', lines: [{ sku: S.skuA.sku, qty: 60 }] });
    ok(r, 201); S.so2 = r.body.id;
    const before = (await api('pat', 'GET', '/purchase-orders')).body.length;
    r = await api('wes', 'POST', `/orders/${S.so2}/allocate`); ok(r);
    assert.strictEqual(r.body.pick_list.tasks, 2);                                                     // spans both bins
    const pos = (await api('pat', 'GET', '/purchase-orders')).body; assert.strictEqual(pos.length, before + 1);
    S.po2 = pos[0]; assert.strictEqual(S.po2.source, 'AUTO_REORDER');
    const d = (await api('pat', 'GET', `/purchase-orders/${S.po2.id}`)).body;
    assert.strictEqual(d.lines[0].vendor_item_number, 'ACME-BOLT-M8-12');
    assert.strictEqual(d.lines[0].qty_ordered, 7);                    // available 18, max 100 -> need 82 -> ceil(82/12)=7 boxes
  });
  await step('short pick: needs reason, releases reservation, flags bin, excluded from re-allocation', async () => {
    const o = (await api('wes', 'GET', `/orders/${S.so2}`)).body; const tasks = o.pick_lists[0].tasks;
    const t1 = tasks[0]; assert.strictEqual(t1.location_code, 'WH1-A01-R1-B1'); assert.strictEqual(t1.qty_to_pick, 30);
    fail(await api('wes', 'POST', `/pick-tasks/${t1.id}/confirm`, { scan_location: 'WH1-A01-R1-B1', scan_item: S.skuA.sku, qty_picked: 20 }), 400);  // reason required
    let r = await api('wes', 'POST', `/pick-tasks/${t1.id}/confirm`, { scan_location: 'WH1-A01-R1-B1', scan_item: S.skuA.sku, qty_picked: 20, short_reason: 'Bin only had 20' }); ok(r);
    assert.strictEqual(r.body.short_qty, 10);
    const bin = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body.find((x) => x.location_code === 'WH1-A01-R1-B1');
    assert.strictEqual(bin.cycle_count_flag, 1); assert.strictEqual(bin.qty_allocated, 0);
    r = await api('wes', 'POST', `/orders/${S.so2}/allocate`); ok(r);      // sources the 10 missing units elsewhere
    assert.strictEqual(r.body.shortages.length, 0);
    const nt = r.body.order.pick_lists[1].tasks; assert.strictEqual(nt.length, 1); assert.strictEqual(nt[0].location_code, 'WH1-A01-R1-B2'); assert.strictEqual(nt[0].qty_to_pick, 10);
    ok(await api('wes', 'POST', '/adjustments', { sku: S.skuA.sku, location: 'WH1-A01-R1-B1', new_qty: 0, reason: 'Cycle count after short pick' }), 201);
    fail(await api('wes', 'POST', '/adjustments', { sku: S.skuA.sku, location: 'WH1-A01-R1-B1', new_qty: 5 }), 400);   // reason is mandatory
  });
  await step('finish order 2 with TWO cartons and a PARTIAL shipment first', async () => {
    const o = (await api('wes', 'GET', `/orders/${S.so2}`)).body;
    const open = o.pick_lists.flatMap((p) => p.tasks).filter((t) => t.status === 'OPEN');
    for (const t of open) ok(await api('wes', 'POST', `/pick-tasks/${t.id}/confirm`, { scan_location: t.location_code, scan_item: S.skuA.barcode, qty_picked: t.qty_to_pick }));
    assert.strictEqual((await api('wes', 'GET', `/orders/${S.so2}`)).body.status, 'PICKED');
    let r = await api('wes', 'POST', `/orders/${S.so2}/cartons`); ok(r, 201); const ca = r.body.id;
    ok(await api('wes', 'POST', `/cartons/${ca}/items`, { scan_item: S.skuA.sku, qty: 40 }), 201);
    ok(await api('wes', 'POST', `/cartons/${ca}/close`, { weight_kg: 50, length_cm: 50, width_cm: 40, height_cm: 30 }));
    r = await api('wes', 'POST', `/orders/${S.so2}/cartons`); ok(r, 201); const cb = r.body.id;
    ok(await api('wes', 'POST', `/cartons/${cb}/items`, { scan_item: S.skuA.sku, qty: 20 }), 201);
    r = await api('wes', 'POST', `/cartons/${cb}/close`, { weight_kg: 25, length_cm: 40, width_cm: 30, height_cm: 30 }); ok(r);
    const sa = (await api('wes', 'GET', `/cartons/${ca}/label`)).body.sscc; assert.notStrictEqual(sa, r.body.carton.sscc);   // SSCCs are unique per carton
    r = await api('wes', 'POST', `/orders/${S.so2}/ship`, { carrier: 'FEDEX', tracking_number: 'FX-1', carton_ids: [ca] }); ok(r, 201);
    assert.strictEqual(r.body.order_status, 'PARTIALLY_SHIPPED');
    r = await api('wes', 'POST', `/orders/${S.so2}/ship`, { carrier: 'FEDEX', tracking_number: 'FX-2' }); ok(r, 201);
    assert.strictEqual(r.body.order_status, 'SHIPPED');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM stock WHERE qty_allocated > qty_on_hand OR qty_on_hand < 0").get().n, 0);
  });
  await step('shortage on allocation -> PARTIALLY_ALLOCATED with backorder qty; cancel releases reservation', async () => {
    let r = await api('wes', 'POST', '/orders', { site_id: S.wh, customer_name: 'Big Buyer', ship_to_line1: '3 Pine', ship_to_city: 'Reno', ship_to_state: 'NV', ship_to_postal_code: '89501', ship_to_country: 'US', lines: [{ sku: S.skuA.sku, qty: 500 }] });
    ok(r, 201); const id = r.body.id;
    r = await api('wes', 'POST', `/orders/${id}/allocate`); ok(r);
    assert.strictEqual(r.body.order.status, 'PARTIALLY_ALLOCATED'); assert.strictEqual(r.body.shortages[0].short_qty, 500 - r.body.order.lines[0].qty_allocated);
    ok(await api('wes', 'POST', `/orders/${id}/cancel`, { reason: 'customer request' }));
    const reserved = db.prepare('SELECT COALESCE(SUM(qty_allocated),0) n FROM stock').get().n; assert.strictEqual(reserved, 0);
  });

  console.log('\n5) FLEET STOCK + VENDOR LIFECYCLE');
  await step('transfer warehouse stock to a fleet vehicle compartment', async () => {
    const r = await api('wes', 'POST', '/transfers', { sku: S.skuA.sku, from_location: 'WH1-A01-R1-B2', to_location: 'VAN-01-REAR', qty: 5, note: 'van restock' }); ok(r, 201);
    const stock = (await api('wes', 'GET', `/stock?sku=${S.skuA.sku}`)).body;
    assert.strictEqual(stock.find((x) => x.location_code === 'VAN-01-REAR').site_code, 'FL1');
    const mv = (await api('wes', 'GET', `/movements?sku=${S.skuA.sku}`)).body; assert.ok(mv.some((m) => m.move_type === 'TRANSFER_SITE'));
    fail(await api('pat', 'PUT', '/reorder-policies', { sku: S.skuA.sku, site_id: S.fl, min_qty: 1, max_qty: 5 }), 400);   // POs are for warehouses
  });
  await step('suspended vendor: no new POs; reorder reports NO_ELIGIBLE_VENDOR instead of failing', async () => {
    ok(await api('cara', 'POST', `/vendors/${S.vendor}/suspend`, { reason: 'Audit finding' }));
    fail(await api('pat', 'POST', '/purchase-orders', { vendor_id: S.vendor, site_id: S.wh, lines: [{ vendor_item_number: 'ACME-NUT-M8-50', qty: 3 }] }), 409);
    ok(await api('pat', 'PUT', '/reorder-policies', { sku: S.skuB.sku, site_id: S.wh, min_qty: 10, max_qty: 50 }));
    const st = (await api('pat', 'GET', '/reorder/status')).body.find((x) => x.sku === S.skuB.sku); assert.strictEqual(st.state, 'NO_ELIGIBLE_VENDOR');
    ok(await api('cara', 'POST', `/vendors/${S.vendor}/reinstate`));
    const run = await api('pat', 'POST', '/reorder/run'); ok(run); assert.strictEqual(run.body.created.length, 1);   // now raises the nut PO
    const po = (await api('pat', 'GET', `/purchase-orders/${run.body.created[0].id}`)).body; assert.strictEqual(po.lines[0].vendor_item_number, 'ACME-NUT-M8-50'); assert.strictEqual(po.lines[0].qty_ordered, 1);
  });
  await step('ledger and audit trail are populated', async () => {
    const types = new Set(db.prepare('SELECT DISTINCT move_type FROM stock_movements').all().map((r) => r.move_type));
    for (const t of ['RECEIPT', 'TRANSFER', 'PICK', 'SHIP', 'ADJUSTMENT', 'TRANSFER_SITE']) assert.ok(types.has(t), 'missing movement type ' + t);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n > 50);
  });

  server.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  process.exit(failed ? 1 : 0);
})();
