'use strict';
const assert = require('assert');

const USERS = {
  pat:   { 'x-user': 'pat',   'x-role': 'PROCUREMENT' },   // submits vendors
  paula: { 'x-user': 'paula', 'x-role': 'PROCUREMENT' },   // approves at procurement stage
  cara:  { 'x-user': 'cara',  'x-role': 'COMPLIANCE' },
  fin:   { 'x-user': 'fin',   'x-role': 'FINANCE' },
  wes:   { 'x-user': 'wes',   'x-role': 'WAREHOUSE' },
  admin: { 'x-user': 'root',  'x-role': 'ADMIN' },
};

function client(base) {
  return async function api(who, method, path, body) {
    const res = await fetch(base + '/api' + path, {
      method, headers: { 'content-type': 'application/json', ...USERS[who] },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };
}

const future = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function vendorProfile(over = {}) {
  return {
    legal_name: 'Acme Industrial Supply LLC', dba_name: 'Acme Supply', business_type: 'LLC',
    tax_id: '12-3456789', country_of_incorporation: 'US', state_of_incorporation: 'DE',
    registration_number: 'DE-7781234', year_established: 2009, duns_number: '123456789', website: 'https://acme.example',
    product_categories: 'Fasteners, Tools', primary_contact_name: 'Dana Reyes', primary_contact_title: 'Account Manager',
    primary_contact_email: 'dana@acme.example', primary_contact_phone: '+1 415 555 0142',
    address_line1: '100 Market St', city: 'San Jose', state: 'CA', postal_code: '95112', country: 'US',
    payment_terms: 'NET30', currency: 'USD', bank_name: 'First Test Bank',
    bank_account_number: '000123456789', bank_routing_number: '021000021',   // valid ABA checksum
    insurance_provider: 'Zurich', insurance_policy_number: 'GL-99812', insurance_coverage_amount: 2000000, insurance_expiry: future(365),
    business_license_number: 'BL-5521', business_license_expiry: future(300),
    lead_time_days_default: 7, min_order_value: 250,
    beneficial_owners: [{ name: 'Dana Reyes', ownership_pct: 60, country: 'US' }, { name: 'Lee Park', ownership_pct: 40, country: 'US' }],
    trade_references: [
      { company: 'Globex Corp', contact: 'Hank Scorpio', email: 'hank@globex.example', phone: '212-555-0101' },
      { company: 'Initech', contact: 'Bill Lumbergh', email: 'bill@initech.example', phone: '512-555-0188' },
    ],
    conflict_of_interest: 0, code_of_conduct_accepted: 1, anti_bribery_attested: 1, sanctions_attested: 1,
    ...over,
  };
}

const DOCS = [
  { doc_type: 'W9', file_name: 'w9.pdf' },
  { doc_type: 'CERTIFICATE_OF_INSURANCE', file_name: 'coi.pdf', expires_on: future(365) },
  { doc_type: 'BUSINESS_LICENSE', file_name: 'license.pdf', expires_on: future(300) },
  { doc_type: 'BANK_LETTER', file_name: 'bank-letter.pdf' },
  { doc_type: 'CODE_OF_CONDUCT_SIGNED', file_name: 'coc.pdf' },
];

/** Drive a vendor from nothing to ACTIVE through the real workflow. Returns the vendor id. */
async function onboardVendor(api, profileOver = {}) {
  let r = await api('pat', 'POST', '/vendors', vendorProfile(profileOver));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  for (const d of DOCS) { r = await api('pat', 'POST', `/vendors/${id}/documents`, d); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); }
  r = await api('pat', 'POST', `/vendors/${id}/submit`); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const detail = (await api('pat', 'GET', `/vendors/${id}`)).body;
  for (const d of detail.documents) { r = await api('cara', 'POST', `/vendors/${id}/documents/${d.id}/verify`, { decision: 'VERIFIED' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); }
  for (const c of detail.checks.filter((x) => !x.automated)) {
    r = await api('cara', 'POST', `/vendors/${id}/checks/${c.check_type}`, { status: 'PASSED', evidence_ref: `RPT-${c.check_type}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  r = await api('cara', 'POST', `/vendors/${id}/approvals/COMPLIANCE`, { decision: 'APPROVED' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('fin', 'POST', `/vendors/${id}/approvals/FINANCE`, { decision: 'APPROVED' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('paula', 'POST', `/vendors/${id}/approvals/PROCUREMENT`, { decision: 'APPROVED' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.status, 'ACTIVE');
  return id;
}

module.exports = { USERS, client, vendorProfile, DOCS, onboardVendor, future };
