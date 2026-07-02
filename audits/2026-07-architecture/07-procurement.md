# Procurement Subsystem Audit — Echelon

Audit date: 2026-07-02. Scope: `server/modules/procurement/**` (~15.5k LOC production + ~10k LOC tests). Read-only audit toward modular monolith with strict single-writer state ownership. All paths relative to `/home/user/Echelon` unless absolute. Line numbers from the current working tree.

---

## 1. SUBSYSTEM MAP

Public interface (`server/modules/procurement/index.ts:1-54`): exports `procurementStorage` (`IProcurementStorage`), `createPurchasingService`, `createReceivingService`, `createShipmentTrackingService`, PO lifecycle change-builders, receipt-reconciliation functions, `renderPoHtml`.

Wiring (`server/services/index.ts:123-146`): `purchasing = createPurchasingService(db, {...procurementStorage, ...})`; `shipmentTracking = createShipmentTrackingService(db, {...procurementStorage, ...})`; `receiving = createReceivingService(db, inventoryCore, channelSync, {...procurementStorage, ...}, purchasing, shipmentTracking, <po-exceptions reporter>)`. `inventoryCore` is `InventoryUseCases` from the inventory module (`server/services/index.ts:82`).

| Area | Files | Role |
|---|---|---|
| Purchase orders | `purchasing.service.ts` (3,652), `purchase-order-lifecycle.service.ts`, `purchase-order-close.service.ts`, `purchase-order.routes.ts` (875) | PO CRUD, dual-track lifecycle (physical/financial), typed-line allocator, totals, receipt creation |
| Receiving | `receiving.service.ts` (1,139), `receiving-orchestration.service.ts`, `purchase-order-receipt-reconciliation.service.ts`, `receiving.routes.ts` (459) | Receipt open/close/discard, CSV bulk import, PO reconciliation, variant creation |
| Landed cost / inbound freight | `shipment-tracking.service.ts` (1,783), `inbound-shipment.routes.ts` | Shipment lifecycle, freight/duty allocation, landed-cost snapshots, push-to-lots |
| Recommendations | `purchasing-recommendation.engine.ts` (1,871), `purchasing-demand-forecast.engine.ts`, `purchasing-recommendation.run-detail.ts`, `purchasing-recommendation.routes.ts` (1,582) | Reorder analysis, auto-draft PO runs, review queue |
| AP | `ap-ledger.service.ts` (2,073), `ap-ledger.routes.ts` | Vendor invoices, payments, 3-way match, PO financial status |
| Exceptions/health | `po-exceptions.service.ts`, `procurement-health*.ts`, `auto-draft-po-*`, `in-flight-po-aging*`, `forecast-*`, `enterprise-dashboard.*` | requires_review surfacing, aging/escalation, dashboards (read-only) |
| Storage | `procurement.storage.ts` (2,276) | Drizzle data access for all of the above |

Replenishment is NOT implemented here — `procurement.routes.ts:9` merely registers `registerReplenishmentRoutes` from `../inventory/replenishment.routes` (route-mounting leak, see §3).

Lot-cost CSV upload: not found in this module. The only CSV cost path is receiving `bulkImportLines` (`receiving.service.ts:837-1116`) which parses per-line `unit_cost` at mills precision. **INSUFFICIENT EVIDENCE** that a dedicated "lot-cost CSV upload" exists in procurement; if it exists it lives in the inventory module (`server/modules/inventory/lots.service.ts`, out of scope).

---

## 2. STATE & WRITERS

Procurement-owned tables (`index.ts:4-9`, matches BOUNDARIES.md:134): vendors, vendorProducts, purchaseOrders, purchaseOrderLines, poApprovalTiers, poStatusHistory, poRevisions, poReceipts, receivingOrders, receivingLines, inboundShipments (+lines/costs/allocations/snapshots/history), vendorInvoices (+lines/links/attachments), apPayments (+allocations), poExceptions, demandEvents, autoDraftRuns, purchasingRecommendationDecisions, reorderExclusionRules.

**Receiving → inventory (the boundary question):** receiving close calls the inventory module's published interface — `this.inventoryCore.receiveInventory({...}, tx)` at `receiving.service.ts:643-658`, passing the receiving transaction so the lot creation + level increment + inventory_transactions audit row happen inside the receiving tx (`server/modules/inventory/application/inventory.use-cases.ts:92-186`: upsert level :114, adjust balance :120, `lotSvc.createLot` :131, `createInventoryTransaction` :157). **This is the correct pattern per BOUNDARIES.md:136-140 and it is the ONLY inventory write path used by receiving.** Every inventory write from procurement code, cited:

1. `receiving.service.ts:643-658` — via `inventoryCore.receiveInventory()` (compliant).
2. `shipment-tracking.service.ts:1645-1656` — **raw SQL `UPDATE inventory.inventory_lots SET landed_cost_mills..., cost_provisional = 0 ...`** (VIOLATION, see §3.1).
3. `shipment-tracking.service.ts:1667-1675` — **raw SQL `UPDATE oms.order_item_costs SET unit_cost_mills...`** (VIOLATION, see §3.2).
4. `procurement.storage.ts:985-988` (`createInventoryLot` → `db.insert(inventoryLots)`) and `:990-996` (`updateInventoryLot` → `db.update(inventoryLots)`) — writer methods on a WMS-owned table exposed by procurement storage. I found no procurement caller (grep across `server/`: only the interface decl `procurement.storage.ts:172-173`, the impl, and `shipment-tracking.service.ts:105` which declares `updateInventoryLot` in its Storage interface but never invokes it — the actual write is the raw SQL in #2). Dormant writer surface (see §3.3).
5. `procurement.storage.ts:1028-1031` (`createOrderItemCost` → insert into `oms.order_item_costs`) and `:1043-1046` (`createOrderItemFinancial`) — writer methods on OMS-schema tables; no callers found in procurement.

**PO state writers (internal fragmentation):** `purchase_orders.status/physical_status/financial_status` is written by (a) `purchasing.service.ts` lifecycle transitions (e.g. tx helper at :645-663), (b) `purchase-order-receipt-reconciliation.service.ts:353-362, 374-383` via `updatePurchaseOrderStatusWithHistory`, (c) `ap-ledger.service.ts:259-279` (financial_status derivation, written atomically in tx :639-662), (d) `receiving.service.ts:404-415` writes `po_status_history` by raw SQL inside the discard tx, (e) route-level history write `purchase-order.routes.ts:862-868`. All inside the procurement module — module-level single-writer holds, but there is no single PO state machine chokepoint.

**Receiving state writers:** `receiving.service.ts` (open/close/complete/bulk), `purchasing.service.ts` (`createReceiptFromPO` :1719-1889, `createReceiptFromShipment` :1904-2046), and **routes writing directly via storage** (`receiving.routes.ts:122, 151, 165, 257, 275, 338, 377, 406, 410` — see §3.6/§4.5).

---

## 3. BOUNDARY VIOLATIONS

### 3.1 (WORST) Procurement writes `inventory.inventory_lots` directly — `shipment-tracking.service.ts:1645-1656`
`pushLandedCostsToLots()` issues raw `UPDATE inventory.inventory_lots SET landed_cost_mills=…, total_unit_cost_mills=…, unit_cost_mills=…, cost_provisional=0, cost_source=…` per lot. `inventory_lots` is a WMS-owned table (BOUNDARIES.md:76) and the sole-writer matrix requires inventory mutations to go through `inventoryCore` (BOUNDARIES.md:156). This mutates inventory valuation (COGS basis) from outside the owner, bypassing the inventory module's audit/notification machinery entirely — no `inventory_transactions` row records the revaluation. Cross-schema raw SQL, per-lot, no wrapping transaction; each failure is swallowed to `console.warn` + `skipped[]` (`:1657-1661`).

### 3.2 Procurement writes `oms.order_item_costs` directly — `shipment-tracking.service.ts:1667-1678`
The COGS cascade updates shipped-order cost rows in the OMS schema by raw SQL. Failure is swallowed: `console.warn(... "(non-fatal)")` (`:1676-1678`) — a permanent COGS mismatch produces only a log line, no `requires_review`. Note the right-direction pattern already exists in this module: `ap-ledger.service.ts:680-698` routes invoice-variance revaluation through `COGSService.reconcileInvoiceVariance()` (inventory module service). The shipment-tracking cascade should do the same.

### 3.3 Foreign-table writer surface in procurement storage — `procurement.storage.ts:985-996, 1028-1046`
`createInventoryLot` / `updateInventoryLot` (inventory schema) and `createOrderItemCost` / `createOrderItemFinancial` (oms schema) are exported on `IProcurementStorage`. Currently apparently uncalled from procurement (see §2 #4-5), but they are loaded weapons: any future procurement code can silently become a second writer of WMS/OMS tables. Also `getInventoryLots/getFifoLots/generateLotNumber` (`:965-1026`) duplicate inventory-module query logic.

### 3.4 Cross-schema reads (lower severity, mostly documented)
- `procurement.storage.ts:1291-1385+` — reorder-analysis reads `inventory.inventory_levels`, `inventory.inventory_transactions`, catalog and orders tables in one bulk SQL. Explicit boundary note at `:1286-1290` justifying it (bulk aggregation; N+1 atpService calls prohibitive). Read-only, deliberate, acceptable short-term; still a schema-coupling seam for a future split.
- `enterprise-dashboard.service.ts:201` (`FROM inventory.inventory_levels`) and `:260-263` (`FROM inventory.inventory_lots` valuation) — undocumented read-only cross-schema queries; the same valuation is available via `inventoryLots.getInventoryValuation()` which `procurement-report.routes.ts:32-33` already uses correctly.

### 3.5 Module composition leaks in routing
`procurement.routes.ts:9` registers inventory's replenishment routes and `:24` registers OMS's `finance-analytics.routes` — procurement's route registrar mounts other modules' HTTP surface. Deep import `ap-ledger.service.ts:28` (`../inventory/cogs.service` — should come from the inventory index). Route files import four other modules' storages directly: `receiving.routes.ts:3-6`, `procurement.routes.ts:3-6`, `purchasing-admin.routes.ts:3-6`, `purchase-order.routes.ts:3-6` (catalog/warehouse/inventory/orders storages).

### 3.6 Routes writing state directly (interface bypass inside the module)
Receiving CRUD writes go straight from Express handlers to storage with no service and no validation: `receiving.routes.ts:122` (create), `:151` (PATCH with raw `req.body` — can set `status` arbitrarily, incl. reopening a closed receipt), `:165/:377` (delete), `:257-278` (line create + order totals), `:338` (line PATCH), `:406-413` (line delete + totals). Vendor CRUD: `procurement.routes.ts:65-99`. Recommendation routes run raw `db.execute` (`purchasing-recommendation.routes.ts:1409, 1418`) and contain the entire auto-draft use-case (see §4.8).

### 3.7 Cross-module side effect inside an open transaction
`receiving.service.ts:697-702` fires `channelSync.queueSyncAfterInventoryChange()` from INSIDE the close transaction (tx spans `:489-712`). If the sync worker reads ATP before commit it pushes stale quantities; if the tx rolls back after queueing, a phantom sync fires. Fire-and-forget with `.catch(console.warn)` — deliberate for a side-channel, but it should be queued post-commit.

---

## 4. CORRECTNESS RISKS (ranked)

### R1 — HIGH: Landed-cost push is non-atomic and fails silently
`pushLandedCostsToLots` (`shipment-tracking.service.ts:1553-1684`): per-lot raw UPDATE (§3.1), then a separate per-lot COGS UPDATE (§3.2) — no transaction across lots or across the lot/COGS pair. Partial failure leaves some lots finalized, others provisional, and lot↔COGS divergence. `close()` treats the whole push as best-effort: `shipment-tracking.service.ts:537-541` catches everything and `console.warn`s ("non-fatal") — a shipment can close with all lots still `cost_provisional=1` and no `requires_review`/dead-letter (violates CLAUDE.md §6/§10). What is not proven: whether an operator-facing reconciliation surfaces stuck provisional lots (`getProvisionalLotsByShipment` exists at `procurement.storage.ts:1266-1271`; I did not find an alerting consumer).

### R2 — HIGH: A "receipt" is not one transaction
The mandated atom is receipt rows + lots + level increments + PO line status. Actual: `receiving.service.close()` wraps inventory posting (lots+levels+audit via `receiveInventory(...,tx)`) + receiving-line updates + receiving-order close in ONE tx (`receiving.service.ts:489-712`) — good. But PO reconciliation runs AFTER commit (`:714-715` → `reconcileLinkedPurchaseOrder` → `purchasing.onReceivingOrderClosed` `purchasing.service.ts:2067-2087` → `reconcilePurchaseOrderReceipt`), where each line's `po_receipts` insert + PO-line update is its own small tx (`procurement.storage.ts:918-945`), and `recalculateTotals` + PO status update are further separate statements (`purchase-order-receipt-reconciliation.service.ts:265-266, 331-387`). Partial-failure behavior: inventory is live and the receipt closed while PO lines/status/receipts are stale. Mitigations that make this loud and recoverable rather than silent: failure throws `ReceivingOrchestrationError` 409 to the client AND records a `receipt_reconciliation_failed` PO exception (`receiving-orchestration.service.ts:102-148`, reporter wired at `server/services/index.ts:141-146`); re-POSTing close on an already-closed order re-runs only the reconciliation (`receiving.service.ts:447-451`); per-line dedupe via unique `(purchase_order_line_id, receiving_line_id)` on `po_receipts` with 23505 → "existing" (`procurement.storage.ts:919-929, 947-958`). Verdict: designed eventual consistency with idempotent repair — but it is not the single transaction CLAUDE.md §8 requires, and repair depends on someone retrying.

### R3 — HIGH: Duplicate variant+location lines silently under-receive
`receiveInventory`'s idempotency pre-check keys on `(receiving_order_id, product_variant_id, to_location_id)` (`inventory.use-cases.ts:97-111`). If one receiving order has TWO lines for the same variant+location (possible: `POST /api/receiving/:orderId/lines` has no duplicate guard, `receiving.routes.ts:227-271`; CSV import dedupes but manual adds don't), line 2's insert-check sees line 1's same-tx receipt row → returns early → **line 2's quantity is never added to inventory, yet the close loop still marks it complete and counts it in `receivedTotalUnits`** (`receiving.service.ts:666-681`). Silent stock undercount with a clean-looking receipt.

### R4 — MEDIUM-HIGH: Concurrent double-close can double-post levels/lots (with audit gap)
Guards in place: HTTP `Idempotency-Key` required on close (`receiving.routes.ts:189`; middleware replays/409s at `server/middleware/idempotency.ts:19-43`); service early-return when already closed (`receiving.service.ts:447`); DB backstop partial unique index `uq_inventory_transactions_receipt_dedup` (`migrations/0578_receipt_dedup_and_freeze_enforcement.sql:69-75`). Gaps: the status read at `receiving.service.ts:441` is outside the tx and `updateReceivingOrder` has no status predicate (`procurement.storage.ts:314-320` — plain `WHERE id=`), so two closes with DIFFERENT idempotency keys (two tabs/operators) both enter the tx. The 23505 backstop then fires on the audit-row insert — but the catch at `inventory.use-cases.ts:174-178` returns WITHOUT rethrowing, so the level increment (step 2, `:120`) and lot creation (step 3, `:131`) already executed in the second tx COMMIT: duplicated stock + duplicate lot with no audit transaction row. **HYPOTHESIS** as to the exact interleaving (depends on READ COMMITTED visibility), but every code step is cited, and the 0578 preflight that voids historical duplicate receipt rows (`:43-66`) is evidence double receipts have actually occurred. Fix: guarded `UPDATE receiving_orders SET status='closed' WHERE id=? AND status IN ('open','receiving')` as the tx's first statement, and rethrow/rollback on `receipt_dedup` 23505.

### R5 — MEDIUM: Financial history is mutable post-close
`PATCH /api/receiving/:id` passes raw `req.body` to storage (`receiving.routes.ts:146-160`) — no field whitelist, no state-machine check: a client can flip a closed receipt back to `draft`/`open` (then re-close; inventory is protected by R4's dedup pre-check, but PO reconciliation re-runs and line data can be edited). `PATCH /api/receiving/lines/:lineId` (`:290-347`) and `completeAllLines` (`receiving.service.ts:727-760`) have no closed-parent guard — received quantities and costs on a CLOSED receipt can be rewritten after inventory and `po_receipts` were posted from the old values. Violates CLAUDE.md §10 (immutable financial history).

### R6 — MEDIUM: PO-line receivedQty read-modify-write race + unit-conversion floor loss
`newReceivedQty = (poLine.receivedQty || 0) + poLineUnitsReceived` computed from a non-locked read (`purchase-order-receipt-reconciliation.service.ts:210-212`) and written as an absolute value inside the per-line tx (`procurement.storage.ts:931-934`) — two receipts against the same PO line closing concurrently lose an update (`po_receipts` sum then ≠ line.receivedQty). Low likelihood for a one-person shop, real at scale. Also `Math.floor(baseUnitsReceived / poUnitsPerVariant)` (`:207-208`) drops remainder base units (receive 1 Case-of-50 against a Case-of-100 PO line → records 0), understating receipts.

### R7 — MEDIUM: `runAllocation` delete-then-recreate without a transaction; float shares
`shipment-tracking.service.ts:1026` deletes all allocations, `:1100` bulk-inserts new ones, `:1121` updates each line — no wrapping tx; a mid-way failure leaves the shipment with NO allocations. Share math is float (`share = bv.basis / basisTotal`, `Math.round(effectiveAmount * share)`, `:1057-1058`) with remainder correction to the largest-basis line (`:1085-1096`) so totals stay exact — deterministic in practice but inconsistent with the BigInt half-up discipline used in `purchasing.service.ts:558-566`; per-line cent placement can differ from the integer method.

### R8 — LOW-MED: Receipt creation lock without atomicity
`createReceiptFromPO` takes `pg_advisory_xact_lock` in a tx (`purchasing.service.ts:1720-1731`) but the work inside uses `storage.*` methods bound to the global `db` (`procurement.storage.ts:1` imports `db`), not the tx — mutual exclusion holds while the tx is open, but order-then-lines are separate commits (`:1776`, `:1887`): a crash leaves an empty draft receipt (matches the abandoned drafts documented in PO-FLOW-AUDIT.md §4). `createReceiptFromShipment` (`purchasing.service.ts:1904-2046`) has no lock at all — reuse check at `:1940-1948` is read-then-create (23505 fallback at `:1968-1975` only catches receipt-number collisions).

### R9 — LOW: max+1 number generation
`generateReceiptNumber` (`procurement.storage.ts:327-344`) and `generateLotNumber` (`:1008-1026`) read-max-then-insert; races produce 23505s that are handled at some call sites (`receiving.routes.ts:139-141`, `purchasing.service.ts:1787-1800`) but not all.

### R10 — LOW: `recalculateTotals` multi-statement, no tx
`purchasing.service.ts:568-608`: per-line updates + PO header update as separate statements; concurrent line edits can leave stale `total_cents` until the next recalc.

### Money discipline (asked): PASS with notes
- PO costs: integer cents/mills throughout; BigInt half-up division `signedRoundHalfUpDiv` (`purchasing.service.ts:558-566`); totals-based line costing (`:226-310`) uses BigInt + `decimal.js` for percent discount/tax; totals aggregation in BigInt (`:328-367`); typed-line allocator all-integer with exact remainder reconciliation (`:415-552`).
- Receiving: mills authoritative with cents mirrors (`receiving.service.ts:150-246`); lot cost derived from PO line TOTALS in mills to avoid pack-size rounding amplification (`:599-641`); CSV `unit_cost` parsed by `dollarsToMills` with Decimal fallback, no floats (`:1008-1038`).
- Landed cost: `computeLotLandedMills` pure integer (`shipment-tracking.service.ts:35-47`); shared money utils reject non-integers (`shared/utils/money.ts:167-207`).
- Float appearances, none persisted as money: recommendation-engine ratios (`purchasing-recommendation.engine.ts:437, 1515` — operational metrics), `runAllocation` shares (R7), per-unit component derivation `Math.round(Number(...)/qty)` (`receiving.service.ts:208-213` — float division then round; deterministic, sub-cent bounded, but inconsistent with `perUnitMills`), display-only `fmtCents` (`purchasing.service.ts:997`). Property tests exist (`__tests__/unit/money-aggregates.property.test.ts`, `mills-precision.service.test.ts`, `receiving-mills.test.ts`).

### Recommendations engine (asked): PURE — read-only
`purchasing-recommendation.engine.ts` and `purchasing-demand-forecast.engine.ts` import no db and perform no writes (verified: zero `db.*`/INSERT/UPDATE matches); inputs are rows fetched by storage (`getReorderAnalysisData`, `procurement.storage.ts:1291+`). State mutation from recommendations happens only via `createPOFromReorder` (`purchasing.service.ts:2091-2175`) and decision/run persistence — but that orchestration lives in the ROUTE (`purchasing-recommendation.routes.ts:1163-1253`: creates run record, generates recs, creates POs, updates run status; `:1043-1094` handoff + decisions), i.e. a use-case implemented in the interface layer.

---

## 5. SEAM ASSESSMENT

- **Receiving→inventory seam: already clean.** `receiveInventory(params, tx)` is a published interface honoring cross-module atomicity via tx handoff — the model the rest of the system should copy. Extraction cost: the shared-tx pattern couples deployment (same DB/process); acceptable for a modular monolith.
- **Landed-cost→inventory seam: broken.** The push writes WMS and OMS tables raw (§3.1/3.2). The needed interface is small: `inventoryLots.finalizeLandedCost(lotId, {landedCostMills, totalMills})` + reuse of existing `COGSService` for the cascade. `storage.updateInventoryLot` and `getProvisionalLotsByShipment` show the intended abstraction half-exists.
- **Procurement→OMS reads** (reorder analysis order-demand SQL, `procurement.storage.ts:1363+`) and **→inventory reads** are bulk analytics; a future split needs a read-model/replication answer, not an RPC per product. Documented note at `:1286-1290` is the right transparency.
- **PO state machine:** transitions are scattered (purchasing.service, reconciliation service, ap-ledger) though change-building is partially centralized in `purchase-order-lifecycle.service.ts` (pure builders — good). Consolidating writes behind one `applyLifecycleChange(tx, change)` would make PO status single-writer in fact, not just by module.
- **Routes:** PO lifecycle + receiving open/close/complete/discard properly delegate to services; receiving/vendor CRUD and the recommendation/auto-draft use-cases do not.
- **Tests:** strong unit coverage of the money paths and reconciliation semantics (49 test files incl. property tests, receipt-discard, add-lines-from-po FOR UPDATE tests). Not covered (by inspection): concurrent double-close race (R4), duplicate variant+location lines (R3), landed-cost push partial failure (R1).

## 6. REFACTOR RECOMMENDATIONS

1. **Kill the raw cross-schema writes** (R1/§3.1/§3.2): add `finalizeLotLandedCost` to the inventory lots service (single tx per lot+COGS pair, or one tx for the batch), call it from `pushLandedCostsToLots`; route the COGS cascade through `COGSService`. Surface push failures as a PO/shipment exception (`po-exceptions` pattern already exists), not `console.warn`.
2. **Make close race-proof** (R4): first statement of the close tx = guarded `UPDATE receiving_orders SET status='closed' WHERE id=$1 AND status NOT IN ('closed','cancelled') RETURNING *`; abort if 0 rows. In `inventory.use-cases.receiveInventory`, rethrow on `receipt_dedup` 23505 (or restructure so the audit insert happens before balance mutation) so the duplicate tx rolls back instead of committing steps 1-3.
3. **Reject duplicate variant+location lines** (R3) at line-create and at close preflight, or make the dedup key include the receiving_line_id.
4. **Lock down post-close mutation** (R5): whitelist PATCHable receiving-order fields, forbid status writes outside the service state machine, and guard line PATCH/complete-all/DELETE with parent-status checks.
5. **Move PO reconciliation into the close transaction** where feasible (R2): `onReceivingOrderClosed` already receives everything needed; passing the close tx through `reconcilePoReceiptLine` (it already accepts per-call txs) would make receipt+lots+levels+PO-line-status one atom. If kept async-by-design, document it as such and add an automated re-drive (currently repair requires a manual re-close).
6. **Extract a recommendations application service** (auto-draft run, handoff, decisions) out of `purchasing-recommendation.routes.ts`; remove `db.execute` from routes.
7. **Delete or relocate foreign-table storage methods** (§3.3): `createInventoryLot/updateInventoryLot/getFifoLots/generateLotNumber/createOrderItemCost/createOrderItemFinancial` belong to inventory/OMS.
8. **Wrap `runAllocation` and receipt-creation in transactions**; convert allocation share math to the BigInt helper; have `createReceiptFromPOUnlocked` use tx-bound storage so the advisory lock also buys atomicity.
9. **Fix lost-update on PO lines** (R6): `FOR UPDATE` the PO line inside `reconcilePoReceiptLine` and compute increments there (`SET received_qty = received_qty + $n`), and stop flooring away sub-pack remainders (store base units or track remainder).
10. **Move channel-sync notification after commit** (§3.7).
11. Route hygiene: stop mounting inventory/OMS routes from `procurement.routes.ts`; import `COGSService` via the inventory index.

## 7. UNKNOWNS

- Whether any dynamic/runtime consumer calls `procurementStorage.createInventoryLot/updateInventoryLot/createOrderItemCost` (static grep found none, but `IProcurementStorage` is exported and spread into service storages — cannot prove zero callers).
- Transaction isolation level in production (assumed Postgres default READ COMMITTED; R4's interleaving analysis depends on it). I cannot verify from the provided code.
- Whether stuck `cost_provisional=1` lots are surfaced anywhere operator-visible (found the query, not an alerting consumer).
- Location/existence of a dedicated lot-cost CSV upload (not in this module).
- `oms.order_item_costs` intended ownership: schema says OMS; inventory's COGSService also writes it (by design?) — the sole-writer matrix in BOUNDARIES.md does not list this table.
- Behavior of `requireIdempotency` under concurrent same-key requests between the SELECT (`middleware/idempotency.ts:29`) and INSERT (`:46`) — no unique-violation handling shown in the excerpt read; the tail of the file was not fully audited.
- Whether the receiving close is exposed anywhere WITHOUT the idempotency middleware (only `/api/receiving/:id/close` was found; `shipment-tracking`'s `getShipmentForReceiving` suggests other flows may exist in UI-land).
