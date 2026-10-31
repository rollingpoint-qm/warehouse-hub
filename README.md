# Warehouse Hub

Vendor onboarding with background checks and approval, multi-warehouse and fleet inventory with sublocations,
min/max reorder that raises purchase orders on the vendor's item number, and pick / pack / ship fulfilment.

Node 22.13+ (uses the built-in SQLite module). Express is the only dependency.

```bash
npm install
npm start                 # http://localhost:3000  (creates warehouse.db)
npm run seed              # optional: load demo data into the running server
npm test                  # 30-step end-to-end test of every rule below (in-memory DB)
```

Use the **Acting as** box (top right) to switch users and roles. Roles: `PROCUREMENT`, `COMPLIANCE`, `FINANCE`,
`WAREHOUSE`, `ADMIN`. Users used by the seed/tests: `pat`/`paula` (procurement), `cara` (compliance), `fin` (finance), `wes` (warehouse).

## 1. Vendor onboarding

`DRAFT -> UNDER_REVIEW -> ACTIVE`  (or `REJECTED`; an active vendor can be `SUSPENDED` and reinstated)

- **Required fields**, checked at submit with a field-by-field error list: legal name, business type, tax ID (EIN format for US), country,
  year established, categories, primary contact (valid email/phone), address, payment terms, currency, bank name/account/routing
  (US routing numbers are ABA-checksum validated), insurance (provider, policy, coverage >= $1M, valid >= 30 more days),
  business licence (valid >= 30 more days), default lead time, >= 1 beneficial owner, >= 2 trade references,
  conflict-of-interest declaration, and three attestations (code of conduct, anti-bribery, sanctions).
- **Required documents**: W-9 (W-8 for non-US), certificate of insurance, business licence, bank letter, signed code of conduct.
  Insurance and licence expiry dates are taken from the uploaded documents.
- **10 background checks**, recorded by Compliance with an evidence reference (failures need notes): tax ID match, business registration,
  sanctions screening, beneficial-owner screening, credit, adverse media/litigation, trade references, insurance verification,
  bank-account verification, plus an **automatic duplicate-vendor screen** (same tax ID, bank account hash, or legal name).
- **Three sequential approvals**: Compliance -> Finance -> Procurement. Compliance cannot approve until every document is verified and every check passed.
  The submitter cannot approve or record checks, and nobody can approve two stages of the same vendor.
  The vendor becomes ACTIVE automatically after the last approval, only if every gate still holds.
- Only ACTIVE vendors with unexpired insurance and licence can be mapped to items or receive POs. "Run expiry sweep" suspends lapsed vendors.

## 2. Inventory structure

- **Sites** are `WAREHOUSE` or `FLEET`; a fleet belongs to a home warehouse. Warehouses get a receiving dock and outbound staging automatically.
- **Sublocations** nest to any depth: zone > aisle > rack > shelf > bin; fleets use vehicle > compartment. Bins carry a pickable flag and a pick-path sequence.
- **SKU** numbers are unique (`SKU-000001`, or a custom unique code); barcodes are unique too.
- **SKU <-> vendor item number**: each vendor maps its own item number to our SKU with pack size, UoM, cost, MOQ and lead time.
  (vendor, vendor item number) and (vendor, SKU) are unique; a SKU can have several vendors, one preferred.
- Stock is held per SKU per location with on-hand and reserved quantities. Every change is written to a movement ledger.
  Transfers cover dock -> bin put-away, bin -> bin, and warehouse -> fleet vehicle.

## 3. Min/max reorder

Policy per SKU per warehouse. `position = available (on hand - reserved) + open PO quantity`. If `position < min`, a PO is raised for
`max - position`, rounded **up** to the vendor's pack size and not below MOQ, so it can exceed max by less than one pack.
Open POs count toward position, so one shortage never raises two POs. The preferred vendor is used; if it is not eligible, the cheapest
eligible vendor item is used; if none, the SKU shows `NO_ELIGIBLE_VENDOR` rather than failing silently.
Evaluation runs automatically after allocation, short picks, transfers, adjustments and policy changes, and on demand ("Run reorder scan").
PO lines are written with the **vendor item number** and keep the link to our SKU. Receiving converts vendor UoM to base units,
blocks over-receipt, and lands goods on the dock.

## 4. Pick, pack, ship

`allocate -> pick -> pack -> ship`; inventory moves the way a WMS does:

1. **Allocate** reserves stock in pickable bins in pick-path order (bins flagged for a count are skipped) and creates a pick list. Shortages are reported as backorder.
2. **Pick** requires scanning the bin and the item (barcode or SKU). Goods move bin -> outbound staging immediately. A **short pick** needs a reason,
   releases the reservation, flags the bin for a cycle count, and the order can be re-allocated from another bin.
3. **Pack** scan-verifies items into cartons (no more than picked, nothing that is not on the order). Closing a carton needs measured weight and dimensions
   (warns if lighter than its contents) and assigns a unique **GS1 SSCC-18** with a valid check digit. Shipping label and packing slip are generated.
4. **Ship** requires a tracking number, ships all closed cartons or a chosen subset (partial shipments supported), issues shipment and BOL numbers, and removes stock from staging.

## Known limits (read before production)

- **No real authentication.** Identity comes from `X-User` / `X-Role` headers. Role and separation-of-duties rules are enforced and audited,
  but anyone can claim any identity. Put SSO/JWT in front of this.
- **Background checks are recorded, not run.** There is no OFAC / credit / KYB provider integration; Compliance records the result and evidence reference.
  Only the duplicate screen is automatic.
- **Documents store a reference, not a file.** Add object storage for real uploads.
- Tax IDs are stored in plain text in SQLite (masked in every API response); encrypt at rest or use a vault.
  Bank account numbers are never stored: only the last 4 digits and a hash.
- SSCC uses the GS1 *example* company prefix `0614141`; set `GS1_COMPANY_PREFIX` to your licensed prefix. Labels show the SSCC and barcode data;
  the label printer renders the scannable symbol.
- Reorder POs are issued automatically as OPEN (no buyer approval step). Min/max applies to warehouses; fleet restocking is by manual transfer.
- Not included: lots/serials/expiry, returns, cancelling an order after picking, multi-currency conversion, carrier rate shopping / label purchase.
- SQLite is single-writer: fine for one site's volume; move to Postgres for heavy concurrent use.

Environment: `PORT` (default 3000), `DB_FILE` (default `warehouse.db`), `GS1_COMPANY_PREFIX`.
