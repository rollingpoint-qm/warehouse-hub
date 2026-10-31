'use strict';
const express = require('express');
const crypto = require('crypto');
const { tx, nextCounter, audit, bad, notFound, conflict } = require('./db');
const { allow } = require('./auth');

// ---------------------------------------------------------------- constants
const BUSINESS_TYPES = ['LLC', 'CORPORATION', 'PARTNERSHIP', 'SOLE_PROPRIETOR', 'NON_PROFIT', 'OTHER'];
const PAYMENT_TERMS = ['NET15', 'NET30', 'NET45', 'NET60', '2/10 NET30'];
const MIN_COVERAGE = 1_000_000;          // minimum general-liability coverage
const MIN_DAYS_VALID = 30;               // insurance/license must be valid at least this long at submit

const CHECK_TYPES = {
  TAX_ID_VERIFICATION:       { label: 'Tax ID / TIN match (IRS or local tax authority)', automated: false },
  BUSINESS_REGISTRATION:     { label: 'Business registration & good standing', automated: false },
  SANCTIONS_SCREENING:       { label: 'Sanctions / watch-list screening (entity)', automated: false },
  BENEFICIAL_OWNER_SCREENING:{ label: 'Beneficial owner sanctions & PEP screening', automated: false },
  CREDIT_CHECK:              { label: 'Credit / financial health report', automated: false },
  ADVERSE_MEDIA_LITIGATION:  { label: 'Adverse media & litigation search', automated: false },
  REFERENCE_CHECK:           { label: 'Trade reference verification', automated: false },
  INSURANCE_VERIFICATION:    { label: 'Insurance certificate verified with carrier', automated: false },
  BANK_ACCOUNT_VERIFICATION: { label: 'Bank account ownership verification', automated: false },
  DUPLICATE_VENDOR_SCREEN:   { label: 'Duplicate vendor screen (tax ID, bank account, name)', automated: true },
};

const STAGES = [
  { stage: 'COMPLIANCE',  seq: 1, role: 'COMPLIANCE' },
  { stage: 'FINANCE',     seq: 2, role: 'FINANCE' },
  { stage: 'PROCUREMENT', seq: 3, role: 'PROCUREMENT' },
];

const OPTIONAL_DOCS = ['NDA', 'DIVERSITY_CERT', 'QUALITY_CERT'];
const requiredDocTypes = (v) => [
  v.country_of_incorporation === 'US' ? 'W9' : 'W8',
  'CERTIFICATE_OF_INSURANCE', 'BUSINESS_LICENSE', 'BANK_LETTER', 'CODE_OF_CONDUCT_SIGNED',
];

const EDITABLE = [
  'legal_name', 'dba_name', 'business_type', 'tax_id', 'country_of_incorporation',
  'state_of_incorporation', 'registration_number', 'year_established', 'duns_number', 'website',
  'product_categories', 'primary_contact_name', 'primary_contact_title', 'primary_contact_email',
  'primary_contact_phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
  'remit_line1', 'remit_city', 'remit_state', 'remit_postal_code', 'remit_country',
  'payment_terms', 'currency', 'bank_name', 'insurance_provider', 'insurance_policy_number',
  'insurance_coverage_amount', 'insurance_expiry', 'business_license_number', 'business_license_expiry',
  'lead_time_days_default', 'min_order_value', 'conflict_of_interest', 'conflict_details',
  'code_of_conduct_accepted', 'anti_bribery_attested', 'sanctions_attested',
];

// ---------------------------------------------------------------- helpers
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
const blank = (x) => x === null || x === undefined || String(x).trim() === '';
const digits = (s) => String(s || '').replace(/\D/g, '');

function abaValid(r) {
  if (!/^\d{9}$/.test(r)) return false;
  const d = r.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

function serialize(v) {
  if (!v) return v;
  const o = { ...v };
  o.beneficial_owners = parseJson(v.beneficial_owners, []);
  o.trade_references = parseJson(v.trade_references, []);
  o.tax_id_masked = v.tax_id ? '•'.repeat(Math.max(0, v.tax_id.length - 4)) + v.tax_id.slice(-4) : null;
  delete o.tax_id;                 // never return the full tax id
  delete o.bank_account_hash;
  return o;
}

function getVendor(db, id) {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!v) throw notFound('Vendor');
  return v;
}

// ---------------------------------------------------------------- validation
/** Everything a vendor profile must contain before it may enter review. */
function validateProfile(v) {
  const errs = [];
  const need = (f, label) => { if (blank(v[f])) errs.push({ field: f, message: `${label} is required` }); };
  need('legal_name', 'Legal name');
  need('business_type', 'Business type');
  if (!blank(v.business_type) && !BUSINESS_TYPES.includes(v.business_type))
    errs.push({ field: 'business_type', message: `Business type must be one of ${BUSINESS_TYPES.join(', ')}` });
  need('tax_id', 'Tax ID');
  need('country_of_incorporation', 'Country of incorporation');
  if (!blank(v.tax_id)) {
    if (v.country_of_incorporation === 'US' && !/^\d{2}-?\d{7}$/.test(v.tax_id))
      errs.push({ field: 'tax_id', message: 'US Tax ID must be a 9-digit EIN (NN-NNNNNNN)' });
    else if (v.country_of_incorporation !== 'US' && String(v.tax_id).length < 5)
      errs.push({ field: 'tax_id', message: 'Tax ID looks too short' });
  }
  need('year_established', 'Year established');
  if (!blank(v.year_established) && !(v.year_established >= 1800 && v.year_established <= new Date().getFullYear()))
    errs.push({ field: 'year_established', message: 'Year established is not a valid year' });
  need('product_categories', 'Product categories');

  need('primary_contact_name', 'Primary contact name');
  need('primary_contact_email', 'Primary contact email');
  if (!blank(v.primary_contact_email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.primary_contact_email))
    errs.push({ field: 'primary_contact_email', message: 'Primary contact email is not valid' });
  need('primary_contact_phone', 'Primary contact phone');
  if (!blank(v.primary_contact_phone) && digits(v.primary_contact_phone).length < 10)
    errs.push({ field: 'primary_contact_phone', message: 'Primary contact phone needs at least 10 digits' });

  need('address_line1', 'Street address'); need('city', 'City'); need('state', 'State/Province');
  need('postal_code', 'Postal code'); need('country', 'Country');

  need('payment_terms', 'Payment terms');
  if (!blank(v.payment_terms) && !PAYMENT_TERMS.includes(v.payment_terms))
    errs.push({ field: 'payment_terms', message: `Payment terms must be one of ${PAYMENT_TERMS.join(', ')}` });
  need('currency', 'Currency');
  if (!blank(v.currency) && !/^[A-Z]{3}$/.test(v.currency))
    errs.push({ field: 'currency', message: 'Currency must be a 3-letter ISO code (e.g. USD)' });
  need('bank_name', 'Bank name');
  need('bank_account_last4', 'Bank account number');
  need('bank_routing_last4', 'Bank routing number');
  need('lead_time_days_default', 'Default lead time (days)');

  need('insurance_provider', 'Insurance provider'); need('insurance_policy_number', 'Insurance policy number');
  if (!(v.insurance_coverage_amount >= MIN_COVERAGE))
    errs.push({ field: 'insurance_coverage_amount', message: `Insurance coverage must be at least ${MIN_COVERAGE.toLocaleString()}` });
  const minValid = addDays(today(), MIN_DAYS_VALID);
  if (!isDate(v.insurance_expiry) || v.insurance_expiry < minValid)
    errs.push({ field: 'insurance_expiry', message: `Insurance must be valid for at least ${MIN_DAYS_VALID} more days` });
  need('business_license_number', 'Business license number');
  if (!isDate(v.business_license_expiry) || v.business_license_expiry < minValid)
    errs.push({ field: 'business_license_expiry', message: `Business license must be valid for at least ${MIN_DAYS_VALID} more days` });

  const owners = Array.isArray(v.beneficial_owners) ? v.beneficial_owners : [];
  if (owners.length < 1) errs.push({ field: 'beneficial_owners', message: 'At least one beneficial owner must be disclosed' });
  let pct = 0;
  owners.forEach((o, i) => {
    if (blank(o.name) || blank(o.country) || !(o.ownership_pct > 0 && o.ownership_pct <= 100))
      errs.push({ field: `beneficial_owners[${i}]`, message: 'Each owner needs name, country and ownership % (0-100]' });
    pct += Number(o.ownership_pct) || 0;
  });
  if (pct > 100.0001) errs.push({ field: 'beneficial_owners', message: 'Ownership percentages exceed 100%' });

  const refs = Array.isArray(v.trade_references) ? v.trade_references : [];
  if (refs.length < 2) errs.push({ field: 'trade_references', message: 'At least 2 trade references are required' });
  refs.forEach((r, i) => {
    if (blank(r.company) || blank(r.contact) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') || digits(r.phone).length < 10)
      errs.push({ field: `trade_references[${i}]`, message: 'Each reference needs company, contact, valid email and phone' });
  });

  if (v.conflict_of_interest !== 0 && v.conflict_of_interest !== 1)
    errs.push({ field: 'conflict_of_interest', message: 'Conflict-of-interest question must be answered' });
  if (v.conflict_of_interest === 1 && blank(v.conflict_details))
    errs.push({ field: 'conflict_details', message: 'Describe the conflict of interest' });
  for (const [f, label] of [['code_of_conduct_accepted', 'Code of conduct'], ['anti_bribery_attested', 'Anti-bribery/anti-corruption attestation'], ['sanctions_attested', 'Sanctions & export-control attestation']])
    if (v[f] !== 1) errs.push({ field: f, message: `${label} must be accepted` });
  return errs;
}

function fullVendor(db, id) {
  const v = serialize(getVendor(db, id));
  const raw = getVendor(db, id);
  v._validation = validateProfile({ ...v, tax_id: raw.tax_id });
  return v;
}

function vendorCtx(db, id) {
  const raw = getVendor(db, id);
  const parsed = { ...raw, beneficial_owners: parseJson(raw.beneficial_owners, []), trade_references: parseJson(raw.trade_references, []) };
  return { raw, parsed };
}

function activationBlockers(db, id) {
  const { parsed } = vendorCtx(db, id);
  const blockers = [];
  validateProfile(parsed).forEach((e) => blockers.push(`Profile: ${e.message}`));
  const docs = db.prepare('SELECT * FROM vendor_documents WHERE vendor_id = ?').all(id);
  for (const t of requiredDocTypes(parsed)) {
    const d = docs.find((x) => x.doc_type === t);
    if (!d) blockers.push(`Document missing: ${t}`);
    else if (d.status !== 'VERIFIED') blockers.push(`Document not verified: ${t} (${d.status})`);
    else if (d.expires_on && d.expires_on < today()) blockers.push(`Document expired: ${t}`);
  }
  const checks = db.prepare('SELECT * FROM vendor_checks WHERE vendor_id = ?').all(id);
  for (const t of Object.keys(CHECK_TYPES)) {
    const c = checks.find((x) => x.check_type === t);
    if (!c || c.status !== 'PASSED') blockers.push(`Check not passed: ${t} (${c ? c.status : 'NOT RUN'})`);
  }
  return blockers;
}

/** Can this vendor be used on a purchase order right now? */
function orderability(db, vendorId) {
  const v = db.prepare('SELECT status, insurance_expiry, business_license_expiry FROM vendors WHERE id = ?').get(vendorId);
  if (!v) return { ok: false, reason: 'Vendor not found' };
  if (v.status !== 'ACTIVE') return { ok: false, reason: `Vendor is ${v.status}, not ACTIVE` };
  if (!v.insurance_expiry || v.insurance_expiry < today()) return { ok: false, reason: 'Vendor insurance has expired' };
  if (!v.business_license_expiry || v.business_license_expiry < today()) return { ok: false, reason: 'Vendor business license has expired' };
  return { ok: true };
}

function runDuplicateScreen(db, id, actor) {
  const v = getVendor(db, id);
  const hits = [];
  const others = db.prepare("SELECT id, vendor_code, legal_name, tax_id, bank_account_hash FROM vendors WHERE id != ? AND status != 'REJECTED'").all(id);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const o of others) {
    if (v.tax_id && o.tax_id && digits(o.tax_id) === digits(v.tax_id)) hits.push(`${o.vendor_code} shares Tax ID`);
    if (v.bank_account_hash && o.bank_account_hash === v.bank_account_hash) hits.push(`${o.vendor_code} shares bank account`);
    if (norm(v.legal_name) && norm(v.legal_name) === norm(o.legal_name)) hits.push(`${o.vendor_code} has same legal name`);
  }
  const status = hits.length ? 'FAILED' : 'PASSED';
  db.prepare(`UPDATE vendor_checks SET status = ?, notes = ?, evidence_ref = 'auto:duplicate-screen',
              performed_by = 'system', performed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE vendor_id = ? AND check_type = 'DUPLICATE_VENDOR_SCREEN'`)
    .run(status, hits.length ? hits.join('; ') : 'No duplicates found', id);
  audit(db, actor, 'vendor', id, 'AUTO_CHECK', { check: 'DUPLICATE_VENDOR_SCREEN', status, hits });
  return { status, hits };
}

// ---------------------------------------------------------------- router
function vendorRouter(db) {
  const r = express.Router();
  const canEdit = allow('PROCUREMENT');
  const canVet = allow('COMPLIANCE');

  r.get('/meta', (req, res) => res.json({
    business_types: BUSINESS_TYPES, payment_terms: PAYMENT_TERMS, min_coverage: MIN_COVERAGE,
    min_days_valid: MIN_DAYS_VALID, check_types: CHECK_TYPES, stages: STAGES,
    optional_docs: OPTIONAL_DOCS,
  }));

  r.get('/', (req, res) => {
    const { status, q } = req.query;
    let sql = 'SELECT * FROM vendors WHERE 1=1'; const p = [];
    if (status) { sql += ' AND status = ?'; p.push(status); }
    if (q) { sql += ' AND (legal_name LIKE ? OR vendor_code LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY id DESC';
    res.json(db.prepare(sql).all(...p).map(serialize));
  });

  function applyBody(body, cur) {
    const out = {};
    for (const f of EDITABLE) if (f in body) out[f] = blank(body[f]) ? null : body[f];
    for (const f of ['year_established', 'lead_time_days_default', 'conflict_of_interest', 'code_of_conduct_accepted', 'anti_bribery_attested', 'sanctions_attested'])
      if (f in out && out[f] !== null) out[f] = Number(out[f]);
    for (const f of ['insurance_coverage_amount', 'min_order_value'])
      if (f in out && out[f] !== null) out[f] = Number(out[f]);
    if ('country_of_incorporation' in out && out.country_of_incorporation) out.country_of_incorporation = String(out.country_of_incorporation).toUpperCase();
    if ('currency' in out && out.currency) out.currency = String(out.currency).toUpperCase();
    if ('beneficial_owners' in body) out.beneficial_owners = JSON.stringify(body.beneficial_owners || []);
    if ('trade_references' in body) out.trade_references = JSON.stringify(body.trade_references || []);
    if (body.bank_account_number) {
      const acct = digits(body.bank_account_number);
      if (acct.length < 4 || acct.length > 17) throw bad('Bank account number must be 4-17 digits');
      out.bank_account_last4 = acct.slice(-4);
      const routing = digits(body.bank_routing_number || '');
      out.bank_account_hash = crypto.createHash('sha256').update(routing + ':' + acct).digest('hex');
    }
    if (body.bank_routing_number) {
      const rt = digits(body.bank_routing_number);
      const country = out.country_of_incorporation || (cur && cur.country_of_incorporation);
      if (country === 'US' && !abaValid(rt)) throw bad('Routing number failed ABA checksum validation');
      if (rt.length < 4) throw bad('Routing number is too short');
      out.bank_routing_last4 = rt.slice(-4);
    }
    return out;
  }

  r.post('/', canEdit, (req, res) => {
    if (blank(req.body.legal_name)) throw bad('legal_name is required to start a vendor record');
    const id = tx(db, () => {
      const fields = applyBody(req.body, null);
      const code = 'V-' + String(nextCounter(db, 'vendor')).padStart(5, '0');
      const cols = ['vendor_code', 'created_by', ...Object.keys(fields)];
      const vals = [code, req.user, ...Object.values(fields)];
      const info = db.prepare(`INSERT INTO vendors (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
      audit(db, req.user, 'vendor', info.lastInsertRowid, 'CREATE', { code });
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(fullVendor(db, id));
  });

  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const vendor = fullVendor(db, id);
    res.json({
      vendor,
      documents: db.prepare('SELECT * FROM vendor_documents WHERE vendor_id = ? ORDER BY id').all(id),
      required_documents: requiredDocTypes({ ...vendor }),
      checks: db.prepare('SELECT * FROM vendor_checks WHERE vendor_id = ? ORDER BY id').all(id)
        .map((c) => ({ ...c, label: CHECK_TYPES[c.check_type]?.label })),
      approvals: db.prepare('SELECT * FROM vendor_approvals WHERE vendor_id = ? ORDER BY seq').all(id),
      blockers: vendor.status === 'UNDER_REVIEW' || vendor.status === 'DRAFT' ? activationBlockers(db, id) : [],
      audit: db.prepare("SELECT ts, actor, action, detail FROM audit_log WHERE entity = 'vendor' AND entity_id = ? ORDER BY id DESC LIMIT 50").all(id),
    });
  });

  r.patch('/:id', canEdit, (req, res) => {
    const id = Number(req.params.id);
    const cur = getVendor(db, id);
    if (cur.status !== 'DRAFT') throw conflict(`Vendor is ${cur.status}; profile can only be edited in DRAFT`);
    tx(db, () => {
      const fields = applyBody(req.body, cur);
      const keys = Object.keys(fields);
      if (keys.length) db.prepare(`UPDATE vendors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fields), id);
      audit(db, req.user, 'vendor', id, 'UPDATE', { fields: keys });
    });
    res.json(fullVendor(db, id));
  });

  // ---- documents
  r.post('/:id/documents', canEdit, (req, res) => {
    const id = Number(req.params.id);
    const v = getVendor(db, id);
    if (v.status === 'REJECTED') throw conflict('Vendor was rejected; reopen it first');
    const { doc_type, reference_no, file_name, issued_on, expires_on } = req.body;
    const allowed = ['W9', 'W8', 'CERTIFICATE_OF_INSURANCE', 'BUSINESS_LICENSE', 'BANK_LETTER', 'CODE_OF_CONDUCT_SIGNED', ...OPTIONAL_DOCS];
    if (!allowed.includes(doc_type)) throw bad(`doc_type must be one of ${allowed.join(', ')}`);
    if (blank(file_name) && blank(reference_no)) throw bad('Provide file_name or reference_no for the document');
    const needsExpiry = ['CERTIFICATE_OF_INSURANCE', 'BUSINESS_LICENSE'].includes(doc_type);
    if (needsExpiry && !isDate(expires_on)) throw bad(`${doc_type} requires expires_on (YYYY-MM-DD)`);
    if (expires_on && !isDate(expires_on)) throw bad('expires_on must be YYYY-MM-DD');
    tx(db, () => {
      db.prepare(`INSERT INTO vendor_documents (vendor_id, doc_type, reference_no, file_name, issued_on, expires_on, uploaded_by)
                  VALUES (?,?,?,?,?,?,?)
                  ON CONFLICT(vendor_id, doc_type) DO UPDATE SET reference_no = excluded.reference_no,
                  file_name = excluded.file_name, issued_on = excluded.issued_on, expires_on = excluded.expires_on,
                  uploaded_by = excluded.uploaded_by, status = 'PENDING', verified_by = NULL, verified_at = NULL, notes = NULL`)
        .run(id, doc_type, reference_no || null, file_name || null, issued_on || null, expires_on || null, req.user);
      // the document is the source of truth for expiry dates on the profile
      if (doc_type === 'CERTIFICATE_OF_INSURANCE') db.prepare('UPDATE vendors SET insurance_expiry = ? WHERE id = ?').run(expires_on, id);
      if (doc_type === 'BUSINESS_LICENSE') db.prepare('UPDATE vendors SET business_license_expiry = ? WHERE id = ?').run(expires_on, id);
      audit(db, req.user, 'vendor', id, 'DOCUMENT_UPLOADED', { doc_type, expires_on });
    });
    res.status(201).json(db.prepare('SELECT * FROM vendor_documents WHERE vendor_id = ? AND doc_type = ?').get(id, doc_type));
  });

  r.post('/:id/documents/:docId/verify', canVet, (req, res) => {
    const id = Number(req.params.id);
    const v = getVendor(db, id);
    if (v.status !== 'UNDER_REVIEW') throw conflict('Documents are verified while the vendor is UNDER_REVIEW');
    const doc = db.prepare('SELECT * FROM vendor_documents WHERE id = ? AND vendor_id = ?').get(Number(req.params.docId), id);
    if (!doc) throw notFound('Document');
    const { decision, notes } = req.body;
    if (!['VERIFIED', 'REJECTED'].includes(decision)) throw bad("decision must be 'VERIFIED' or 'REJECTED'");
    if (decision === 'REJECTED' && blank(notes)) throw bad('Notes are required when rejecting a document');
    if (decision === 'VERIFIED' && doc.expires_on && doc.expires_on < today()) throw bad('Document is already expired and cannot be verified');
    db.prepare(`UPDATE vendor_documents SET status = ?, verified_by = ?, verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), notes = ? WHERE id = ?`)
      .run(decision, req.user, notes || null, doc.id);
    audit(db, req.user, 'vendor', id, 'DOCUMENT_' + decision, { doc_type: doc.doc_type, notes });
    res.json(db.prepare('SELECT * FROM vendor_documents WHERE id = ?').get(doc.id));
  });

  // ---- submit for review
  r.post('/:id/submit', canEdit, (req, res) => {
    const id = Number(req.params.id);
    const { raw, parsed } = vendorCtx(db, id);
    if (raw.status !== 'DRAFT') throw conflict(`Vendor is ${raw.status}; only DRAFT vendors can be submitted`);
    const errs = validateProfile(parsed);
    const docs = db.prepare('SELECT doc_type FROM vendor_documents WHERE vendor_id = ?').all(id).map((d) => d.doc_type);
    for (const t of requiredDocTypes(parsed)) if (!docs.includes(t)) errs.push({ field: 'documents', message: `Required document missing: ${t}` });
    if (errs.length) throw bad('Vendor application is incomplete', errs);
    tx(db, () => {
      db.prepare("UPDATE vendors SET status = 'UNDER_REVIEW', submitted_by = ?, submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status_reason = NULL WHERE id = ?").run(req.user, id);
      for (const [type, meta] of Object.entries(CHECK_TYPES))
        db.prepare('INSERT OR IGNORE INTO vendor_checks (vendor_id, check_type, automated) VALUES (?,?,?)').run(id, type, meta.automated ? 1 : 0);
      for (const s of STAGES)
        db.prepare('INSERT OR IGNORE INTO vendor_approvals (vendor_id, stage, seq) VALUES (?,?,?)').run(id, s.stage, s.seq);
      audit(db, req.user, 'vendor', id, 'SUBMITTED');
      runDuplicateScreen(db, id, 'system');
    });
    res.json(fullVendor(db, id));
  });

  // ---- background checks
  r.post('/:id/checks/:type', canVet, (req, res) => {
    const id = Number(req.params.id);
    const v = getVendor(db, id);
    const type = req.params.type;
    if (!CHECK_TYPES[type]) throw notFound('Check type');
    if (v.status !== 'UNDER_REVIEW') throw conflict('Checks are recorded while the vendor is UNDER_REVIEW');
    if (CHECK_TYPES[type].automated) {
      const out = tx(db, () => runDuplicateScreen(db, id, req.user));
      return res.json({ check_type: type, ...out });
    }
    const { status, evidence_ref, notes } = req.body;
    if (!['PASSED', 'FAILED'].includes(status)) throw bad("status must be 'PASSED' or 'FAILED'");
    if (blank(evidence_ref)) throw bad('evidence_ref (report / case / confirmation number) is required');
    if (status === 'FAILED' && blank(notes)) throw bad('Notes are required when a check fails');
    // a vendor's own submitter must not clear their screening
    if (req.user === v.submitted_by) throw conflict('Segregation of duties: the submitter cannot record background check results');
    tx(db, () => {
      db.prepare(`UPDATE vendor_checks SET status = ?, evidence_ref = ?, notes = ?, performed_by = ?,
                  performed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vendor_id = ? AND check_type = ?`)
        .run(status, evidence_ref, notes || null, req.user, id, type);
      audit(db, req.user, 'vendor', id, 'CHECK_' + status, { check: type, evidence_ref, notes });
    });
    res.json(db.prepare('SELECT * FROM vendor_checks WHERE vendor_id = ? AND check_type = ?').get(id, type));
  });

  // ---- approvals (sequential: COMPLIANCE -> FINANCE -> PROCUREMENT)
  r.post('/:id/approvals/:stage', (req, res, next) => {
    const st = STAGES.find((s) => s.stage === String(req.params.stage).toUpperCase());
    if (!st) return next(notFound('Approval stage'));
    return allow(st.role)(req, res, (denied) => {
      if (denied) return next(denied);     // role check failed: forward the 403, do not continue
      try {
        const id = Number(req.params.id);
        const v = getVendor(db, id);
        if (v.status !== 'UNDER_REVIEW') throw conflict(`Vendor is ${v.status}; approvals apply to UNDER_REVIEW vendors`);
        const { decision, comments } = req.body;
        if (!['APPROVED', 'REJECTED'].includes(decision)) throw bad("decision must be 'APPROVED' or 'REJECTED'");
        if (decision === 'REJECTED' && blank(comments)) throw bad('Comments are required to reject a vendor');
        const rows = db.prepare('SELECT * FROM vendor_approvals WHERE vendor_id = ? ORDER BY seq').all(id);
        const me = rows.find((a) => a.stage === st.stage);
        if (me.decision !== 'PENDING') throw conflict(`${st.stage} stage already ${me.decision}`);
        const prev = rows.find((a) => a.seq === st.seq - 1);
        if (prev && prev.decision !== 'APPROVED') throw conflict(`${prev.stage} approval must be completed first`);
        if (req.user === v.submitted_by) throw conflict('Segregation of duties: the person who submitted the vendor cannot approve it');
        if (rows.some((a) => a.approver === req.user)) throw conflict('Segregation of duties: one person cannot approve multiple stages for the same vendor');
        if (decision === 'APPROVED') {
          // Compliance approval requires everything vetted; later stages require nothing regressed.
          const all = activationBlockers(db, id);
          const relevant = st.stage === 'COMPLIANCE'
            ? all
            : all.filter((b) => /expired|\(FAILED\)|\(REJECTED\)|^Profile/.test(b));
          if (relevant.length) throw conflict(`Cannot approve: ${relevant.length} item(s) outstanding`, relevant);
        }
        let activated = false;
        tx(db, () => {
          db.prepare(`UPDATE vendor_approvals SET decision = ?, approver = ?, comments = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vendor_id = ? AND stage = ?`)
            .run(decision, req.user, comments || null, id, st.stage);
          audit(db, req.user, 'vendor', id, `APPROVAL_${decision}`, { stage: st.stage, comments });
          if (decision === 'REJECTED') {
            db.prepare("UPDATE vendors SET status = 'REJECTED', status_reason = ? WHERE id = ?").run(`${st.stage}: ${comments}`, id);
          } else if (st.seq === STAGES.length) {
            const left = activationBlockers(db, id);
            if (left.length) throw conflict('Cannot activate vendor', left);
            db.prepare("UPDATE vendors SET status = 'ACTIVE', activated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
            audit(db, req.user, 'vendor', id, 'ACTIVATED');
            activated = true;
          }
        });
        res.json({ ...fullVendor(db, id), activated });
      } catch (e) { next(e); }
    });
  });

  // ---- lifecycle
  r.post('/:id/suspend', canVet, (req, res) => {
    const id = Number(req.params.id); const v = getVendor(db, id);
    if (v.status !== 'ACTIVE') throw conflict('Only ACTIVE vendors can be suspended');
    if (blank(req.body.reason)) throw bad('reason is required');
    db.prepare("UPDATE vendors SET status = 'SUSPENDED', status_reason = ? WHERE id = ?").run(req.body.reason, id);
    audit(db, req.user, 'vendor', id, 'SUSPENDED', req.body.reason);
    res.json(fullVendor(db, id));
  });

  r.post('/:id/reinstate', canVet, (req, res) => {
    const id = Number(req.params.id); const v = getVendor(db, id);
    if (v.status !== 'SUSPENDED') throw conflict('Only SUSPENDED vendors can be reinstated');
    const o = (() => {
      const x = db.prepare('SELECT insurance_expiry, business_license_expiry FROM vendors WHERE id = ?').get(id);
      const errs = [];
      if (!x.insurance_expiry || x.insurance_expiry < today()) errs.push('Insurance has expired - upload a renewed certificate');
      if (!x.business_license_expiry || x.business_license_expiry < today()) errs.push('Business license has expired - upload a renewed license');
      const pend = db.prepare("SELECT doc_type FROM vendor_documents WHERE vendor_id = ? AND status != 'VERIFIED'").all(id);
      pend.forEach((d) => errs.push(`Document not verified: ${d.doc_type}`));
      return errs;
    })();
    if (o.length) throw conflict('Cannot reinstate vendor', o);
    db.prepare("UPDATE vendors SET status = 'ACTIVE', status_reason = NULL WHERE id = ?").run(id);
    audit(db, req.user, 'vendor', id, 'REINSTATED');
    res.json(fullVendor(db, id));
  });

  r.post('/:id/reopen', canEdit, (req, res) => {
    const id = Number(req.params.id); const v = getVendor(db, id);
    if (v.status !== 'REJECTED') throw conflict('Only REJECTED vendors can be reopened');
    tx(db, () => {
      db.prepare('DELETE FROM vendor_checks WHERE vendor_id = ?').run(id);
      db.prepare('DELETE FROM vendor_approvals WHERE vendor_id = ?').run(id);
      db.prepare("UPDATE vendor_documents SET status = 'PENDING', verified_by = NULL, verified_at = NULL WHERE vendor_id = ?").run(id);
      db.prepare("UPDATE vendors SET status = 'DRAFT', submitted_by = NULL, submitted_at = NULL WHERE id = ?").run(id);
      audit(db, req.user, 'vendor', id, 'REOPENED', { previous_reason: v.status_reason });
    });
    res.json(fullVendor(db, id));
  });

  /** Suspend every ACTIVE vendor whose insurance or licence has lapsed. */
  r.post('/actions/expiry-sweep', canVet, (req, res) => {
    const lapsed = db.prepare(`SELECT id, vendor_code, insurance_expiry, business_license_expiry FROM vendors
      WHERE status = 'ACTIVE' AND (insurance_expiry < ? OR business_license_expiry < ?)`).all(today(), today());
    tx(db, () => {
      for (const v of lapsed) {
        const why = v.insurance_expiry < today() ? 'Insurance expired' : 'Business license expired';
        db.prepare("UPDATE vendors SET status = 'SUSPENDED', status_reason = ? WHERE id = ?").run(why, v.id);
        audit(db, req.user, 'vendor', v.id, 'SUSPENDED', why + ' (expiry sweep)');
      }
    });
    res.json({ suspended: lapsed.map((v) => v.vendor_code) });
  });

  return r;
}

module.exports = { vendorRouter, orderability, CHECK_TYPES, today, addDays };
