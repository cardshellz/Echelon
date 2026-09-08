# Supplier sourcing completion

The supplier catalog now exposes versioned sourcing priority, proposal eligibility and reusable quantity price lists. `SupplierSourcingService.update` writes immutable actor/time/reason/before/after revisions under the catalog graph and mapping locks. Revision checks reject concurrent stale edits; command keys replay their original result. Migration 228 rejects updates, deletes and truncation of retained policy evidence.

`getReorderAnalysisData` loads all supplier candidates within the same repeatable-read snapshot as inventory and receipts. `prepareSupplierSourcingRow` evaluates each supplier's lead time, MOQ and order multiples, then ranks eligible candidates by preferred flag, ascending priority, receive-variant specificity, lead time and stable identity. It retains inactive, paused and incompatible mappings with rejection reasons. Prices never influence the ranking; no currency conversion authority is invented.

`selectSupplierPriceTier` selects the inclusive threshold at the already required quantity. Thresholds use the explicitly quoted piece or purchase unit. It never increases quantities for a discount. Currency, quote source, date range, purchase-unit conversion and integer mills are mandatory. Unusable/expired tiers become unpriced RFQ proposals. Exact normalized price, quoted-unit price and signed rounding remainder are retained by the existing PO owner.

The daily order builder shows captured supplier evidence and supports an explained supplier override. Overrides use the alternate's proposed quantity and exact mapping ID and create RFQs for review. They preserve the catalog preference. RFQ detail and PO-linked RFQ detail retain the original ranking and price evidence. Automatic RFQ preparation can propose a current-quote alternate; it never sends the RFQ or creates financial commitments. An alternate PO requires an operator acceptance. PO handoff revalidates active identity, current tier revision, validity and requested quantity atomically; changed tiers require another review. A final RFQ quote can explicitly supersede the original proposal while preserving it as history.

New captures identify calculation version `purchasing-recommendation-v4-supplier-sourcing`. Historical captures remain readable and exact RFQ command replay remains supported. Captures without validated sourcing evidence cannot authorize a new automatic sourcing RFQ. Legacy manual behavior remains compatible; old accepted prices cannot authorize newly configured tiers.

## Integration wiring

- Export `./schema/supplier-sourcing.schema` from `shared/schema.ts`.
- Import and invoke `registerSupplierSourcingRoutes(app)` from `server/modules/procurement/supplier-sourcing.routes.ts` in the global route composition.
- Run migration `228_supplier_sourcing_policies.sql` before the updated planning reader.
- Include `supplier-sourcing.integration.test.ts` in the explicit CI PostgreSQL list. Existing `rfq-workflow.integration.test.ts` now installs migration 130 plus 228 for real recommendation PO owner coverage.

## Verification

- Broad procurement and purchasing/catalog client unit suites: 176 files, 2063 passing tests, 14 existing skips before the final boundary additions; focused changed suites were rerun afterward.
- Real disposable PostgreSQL: sourcing policy audit/replay/concurrency/rollback and DB validation; actual repository to engine capture; actual RFQ quote/PO owner conversion and replay; exact 100001 mills per three-piece unit, 33334 normalized mills, 3000 total cents and -3 remainder mills; changed revision and expired quote fail without PO records; explicit product-level mapping RFQ creates no replacement catalog row.
- HTTP tests cover permissions, actor identity, invalid identifiers, replay headers and classified errors.
- Browser tests pass in installed Chrome on desktop and mobile: exact tier editing, history, validation, view-only access and manual alternate RFQ with required reason and exact supplier ID. The browser API fixtures are synthetic; they do not prove a production deployment.
- TypeScript uses `--incremental false`; all database execution uses an explicitly disposable local database.

## Operational boundaries

Existing supplier rows begin at revision zero with priority 100, eligible and no tier list. Historical quotes are retained; operators must enter the vendor's actual reusable quantity quote before tiers apply. New pricing lists describe product prices; final RFQ quote and existing landed-cost owners still capture packaging, freight, tax and other costs. Manual PO authoring retains its existing explicit quote workflow; this change consumes reusable tiers through the recommendation owner. Non-USD automatic PO handoff still requires an explicit FX authority. No supplier delivery, preference change, production database write or automation setting activation is performed by this change.
