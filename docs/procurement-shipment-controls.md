# Procurement shipment command controls

Evidence below was traced from `6390f7cf` before C1 edits. Line references identify that baseline; function names remain the primary lookup when subsequent changes move lines. No production records were inspected or changed during this audit.

## C1 contract boundary

The cost command DTO separates editable shipment cost evidence from parent identity, AP invoice/payment state and generated fields. It retains signed safe-integer cents because `ap-ledger.service.ts:getShipmentCostPaymentStatus` (3800–3804) explicitly supports seller promotion credits. Null, zero and omission remain distinct. The USD/one exchange-rate constraint follows the existing accounting boundary; this change does not introduce FX conversion.

Header DTOs preserve the fields submitted by `InboundShipments.tsx:createMutation` (223–237), `PurchaseOrderDetail.tsx:createShipmentMutation` (2345–2357), and `InboundShipmentDetail.tsx` edit initialization/save (1300–1324, 2519–2529). Generic input cannot supply status, actors, allocation defaults, lifecycle timestamps or recomputed totals. List/PO creation uses `sea_fcl`, `ground`, etc.; detail editing also exposes `ocean`, `truck` and `rail` (2296–2305). Both existing vocabularies are accepted without inferring a mapping. The service remains responsible for state, concurrency and persistence.

## C1 charge execution and recovery

The HTTP handlers in `inbound-shipment.routes.ts:handleCostCommand` require the existing purchasing edit permission, a real authenticated actor and an `Idempotency-Key`. Canonical positive IDs are bounded to PostgreSQL integer range before reservation. `shipment-cost-commands.ts:shipmentCostCommandScope` binds method, route, resource and command name to the requested operation; the application factory checks the descriptor against that scope.

`createShipmentCostCommands` uses the existing financial command ledger and transaction owner. A stable service principal scopes reservation/replay so a delegated user retry with the same key cannot duplicate the charge; the actual human remains the audit actor. Changed payloads with a reused key conflict. The charge write, economic totals/allocations, full before/after audit and successful result commit together. Input constraints on the charge itself produce durable rejection; audit/allocation infrastructure failures roll back and retain a recoverable command.

`shipment-tracking.service.ts:executeCostCommandInTransaction` parses strict DTOs, locks the parent shipment and then the charge, rereads its current data, and checks both the invoice header link and any surviving invoice-line source reference. PATCH and DELETE require the SHA-256 content token from `shipment-cost-version.ts:shipmentCostVersion`; it covers every stored charge field, including AP and timestamp changes. This is a content token, not a new database revision column. Enriched display fields are excluded. A conflicting edit requires explicit reload and review.

Invoice-referenced charges permit descriptive metadata only. Their amount/category/allocation/currency/vendor/invoice-date evidence cannot be changed here, and deletion cannot clear invoice-line lineage. Unreferenced economic commands require USD at a recorded unit exchange rate across the shipment; unknown or foreign historical basis remains readable and metadata editable. Numerically equivalent unit-rate strings and unchanged amounts do not trigger allocation or reset historical status. The command clock supplies charge/audit timestamps. Exact integer accumulation rejects totals outside the safe supported range.

`client/src/lib/shipment-cost-command.ts` parses monetary input with integer arithmetic and omits unchanged economic fields, preserving distinct estimates, actuals, custom historical categories and timestamps during metadata correction. `shipment-cost-create-recovery.ts:createShipmentCostRecoveryStore` stages the exact create body/key in session storage before dispatch, scoped to authenticated user and shipment. The detail screen freezes unresolved creation and offers explicit retry after failure or reload; it never executes recovery automatically. Storage errors block a new create instead of losing the recovery key. Session storage lasts for that tab session; clearing it or closing the tab ends client recovery. The durable server ledger persists independently, but this change does not add cross-device recovery discovery.

No database migration, historical backfill, production row export, carrier connection, purchase automation activation or financial reconciliation is included.

## C1 closure and parent mutation controls

`shipment-tracking.service.ts:close` now keeps allocation finalization, the closed header and status history in one shipment-locked transaction. The extracted `finalizeAllocationsInTransaction` retains the existing dimension gate, exact allocation validation, snapshots and adjustment behavior; standalone finalization still uses its own transaction wrapper. `transitionTo` also locks and rechecks the current status, then updates the header and history in that transaction, preventing a stale cancellation from overwriting a completed close. The injected service clock supplies snapshot, closure and recorded-history timestamps; supplied transit/delivery event dates remain caller evidence.

`procurement.storage.ts:createInboundShipmentStatusHistory` accepts the transaction executor. Finalization/header/history failures therefore roll back the close together. `deleteShipment` now checks for charges under its shipment lock before permitting the existing draft-only deletion; a parent cascade cannot bypass controlled charge deletion. The general requirement to preserve draft history remains separate from this charge-protection guard.

After closure commits, the existing `pushLandedCostsToLots` follow-up still runs in its own transaction. Its failure does **not** undo the committed close: snapshots remain available for the existing manual retry and later receiving behavior. A structured warning records the shipment, actor and classified error without exposing raw database diagnostics. This limitation is intentional and is not represented as successful inventory cost propagation.

## Remaining outside C1

### Shipment line changes can commit before a terminal-state error

`shipment-tracking.service.ts:updateLineDimensions` (1000–1035) writes the line and header totals before `refreshAllocationsForShipment` (483–497) checks closed/cancelled state. `resolveDimensionsForShipment` (1075–1116) also writes before that check. `removeLine` (985–997) and `importPackingList` (1119–1178) check status before their writes but do not share a transaction with aggregate/allocation refresh. `addLinesFromPO` (850–981) transacts PO-line validation/insertion but recomputes shipment totals and allocation afterward. Storage line writes (1168–1185) use the global database unless their individual method accepts an executor.

Consequently an allocation or terminal-state failure can leave an earlier line/header mutation committed. A corrective slice needs parent-state validation under the same lock/transaction as line mutations, totals and allocations, with PostgreSQL rollback/concurrency tests. The necessary lock order must be checked against receipt, cost and PO writers before implementation. Production occurrence is unknown.

### Quantity protection differs by entry point

`addLinesFromPO` validates product type, line status and `orderQty - alreadyShipped - cancelledQty` only when `qtyMap.size > 0` (903–934). Its legacy `lineIds`/omitted-selection branch writes full order quantity (939). Current shipment detail still calls that legacy branch (751–752, 2709), so this is a live UI path. The UI only excludes lines already on the current shipment (472–477), and displays open quantity as ordered minus received (2692–2693). `updateLineDimensions` permits `qtyShipped` without checking the PO remaining amount. `importPackingList` performs only a truthy/positive quantity check (1140–1142) and accepts independent PO-line/variant/SKU references while setting direct `purchaseOrderId` to null (1154–1166).

A separate slice should share PO-line eligibility and remaining-quantity validation across selected/legacy adds, quantity amendments and PO-linked imports; validate every requested identity; and preserve explicit unlinked rows without inferring a PO from SKU. Existing tests deliberately preserve the full-order legacy behavior (`add-lines-from-po.test.ts`, 152 and 273), so callers and tests must change together. Whether over-order exceptions or post-receipt quantity amendments are allowed is not established by this audit.

### Packing-list CSV sends different field names and hides row errors

`InboundShipmentDetail.tsx:handleFileSelect` maps `qty_shipped`, `weight_kg`, etc. (1013); `buildImportRows` returns those names unchanged (1030–1039). The service expects `qtyShipped`, `weightKg`, etc. (1119–1128). Thus rows produced by the current mapping have no `qtyShipped` and are collected as row errors (1140–1142). The UI success handler ignores `result.errors`, closes the dialog and reports the imported count (773–777).

Correct the explicit CSV-to-command mapping, validate numeric values and row identities, retain/display rejected rows and preserve the import response contract. The desired policy for partial import versus atomic rejection is not specified. Repeated import also has no identified row idempotency key; a future retry contract needs an explicit source-row identity rather than SKU-based deduplication.

### Null-clearing and pack conversion can alter quantity or retain stale totals

`updateLineDimensions` computes using `updates.field ?? stored.field` (1013–1018), then writes explicit null dimensions (1024–1027). Clearing a dimension can therefore preserve totals computed from the previous value. A null carton count is replaced by the previous carton count and cannot clear it (1014, 1028).

`getEnrichedLines` returns current variant `unitsPerVariant` (621). Shipment creation prefers the PO's recorded expected-receive conversion (943–949); it rounds carton count upward for partial cartons. `InboundShipmentDetail.tsx:handleSaveLineEdit` recomputes pieces as carton count times the current variant conversion for packed items (1057–1061, 1082–1084). For example the existing 501-piece/50-per-carton fixture (`add-lines-from-po.test.ts`, 232–270) creates 11 cartons; saving that case count computes 550 pieces. Dimension-only edits should preserve explicit recorded quantity. The correct historical conversion and handling of partial cartons need an explicit contract.

### Creation history and the draft deletion/archive policy remain separate work

At the audited baseline, `createShipment` separately inserted the header and recorded history (669–686). Physical draft deletion also cascades shipment lines and status history (`procurement.schema.ts`, 1540 and 1751), and line deletion cascades landed-cost snapshots/adjustments (1700 and 1729). C1 blocks parent deletion when charges exist and makes transitions/closure atomic, but does not replace empty-draft deletion with an archive policy or make header creation/history atomic. These remaining behaviors are not equivalent to preserving all historical detail; this audit does not prove live data loss.

### Signed allocation and reporting consumers are not repaired by C1

Accepting a signed command does not prove every downstream cost consumer can handle credits. The existing AP payment projection accepts signed cost evidence; the shipment allocator and invoice-creation bridge have separate validation and financial rules. C1 must preserve their existing rejection/rollback behavior and must not claim that signed allocation, credit invoicing, FX, PO-specific financial allocation or historical reconciliation has been solved.

## Validation needed for the follow-up line slice

Use service tests for all command/terminal-state combinations, unknown and duplicate IDs, non-product and closed/cancelled PO lines, exact remaining quantity, quantity edits, zero/null/invalid values, CSV mapping/errors and partial cartons. Use disposable PostgreSQL tests for parallel shipments consuming the same PO remainder, line mutation racing a terminal transition, and rollback after aggregate/allocation/history failure. Browser tests should cover actual legacy Add from PO, dimension-only save and partial-import error visibility. No production behavior or concurrency outcome should be claimed from mocked tests alone.

## Evidence and verification boundaries

- Strict DTO tests exercise unknown/server-owned fields, invalid IDs and dates, null/zero/omission, supported currencies and signed integer limits.
- Application/HTTP tests exercise permission wiring, authenticated audit actors, descriptor scope, replayed status/body, conflict headers, failure classification and content-version changes.
- The disposable PostgreSQL suite calls production shipment service/storage and the real command repository. It installs schema-derived table columns plus relevant foreign keys, runs rollback and concurrency schedules, and observes actual lock waits with `pg_blocking_pids`. It proves invoice-header and invoice-line source guards, exact totals, audit rollback, delegated replay, source constraints, atomic closure and competing cancellation. It is a controlled integration fixture, not a production-data audit or a full production migration rehearsal.
- Browser tests use the actual React interface with fictional API fixtures. They prove operator interactions and request payloads; PostgreSQL tests separately prove persistence. Scenarios cover protected metadata, create retry/reload, definitive stale-version review, controlled deletion, storage failures and confirmed-save/failed-refresh messaging.
- Existing financial-command PostgreSQL guarantees, the full unit suite, typecheck and the write-authority ratchet remain required. C1 adds its own named step to the existing PostgreSQL CI job.

Production incidence of the remaining gaps, completeness of historical costs, and final cost propagation into inventory/Archon have not been verified by these tests.
