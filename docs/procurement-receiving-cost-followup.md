# Receiving cost follow-up: source identity, unit basis, and cost layers

Audit baseline: `bb21c9647647682756e5663a022f40bb4a8afe77` (merged shipment-line controls). The source references below use that commit's line numbers. W02a quantity/source work is being implemented separately; this document records the financial follow-up and does not claim those writers have been corrected.

Scope: receiving close, inventory receipt and lot creation, PO receipt reconciliation, approved invoice cost reconciliation, shipment landed-cost finalization/application, and receipt reversal. No production business rows were read or modified. Production frequency and affected monetary totals are unknown.

## What the code definitely does

### Posting and quantity ownership

1. `ReceivingService.close` reads the receipt, refreshes its prepared snapshot, locks the receiving header, rechecks its timestamp and the line timestamps, then posts each positive received line inside one transaction. It replays a previously closed receipt without reposting inventory. See `server/modules/procurement/receiving.service.ts:989–999, 1089–1120`.
2. Receiving quantity is the selected variant's count. Close reads **live** `catalog.product_variants.units_per_variant` to scale its base-piece cost to a lot-unit cost, then passes `receivedQty` unchanged to inventory. See `receiving.service.ts:1234–1294`.
3. `InventoryUseCases.receiveInventory` uses `receivingLineId` for its advisory replay lock and receipt-ledger lookup, adds variant quantity to inventory, creates a lot when its lot service is present, and writes the exact receiving-line/lot pair to the inventory transaction. See `server/modules/inventory/application/inventory.use-cases.ts:139–264`. An injected lot service is optional at this interface; a closed receipt alone is not proof of a lot.
4. Lots retain receiving-header, purchase-header, PO-line and shipment-header IDs. At the audited baseline neither receiving lines nor lots have an exact shipment-line ID or a frozen receive-unit conversion. The receipt transaction carries the exact receiving-line/lot relationship. See `shared/schema/procurement.schema.ts:373–418`, `shared/schema/inventory.schema.ts:435–441, 903–955`, and `server/modules/inventory/lots.service.ts:135–165`.
5. PO reconciliation runs **after** the receipt/inventory transaction commits. `purchasing.onReceivingOrderClosed` opens another transaction and locks the PO header; `reconcilePurchaseOrderReceipt` converts receiving units to base pieces using another live variant lookup, persists a per-receiving-line `po_receipts.qtyReceived` snapshot, and updates the PO tally. See `receiving.service.ts:1363–1377`, `server/modules/procurement/purchasing.service.ts:4487–4549`, and `server/modules/procurement/purchase-order-receipt-reconciliation.service.ts:224–317`.
6. Incomplete PO reconciliation is surfaced as an actionable failure after physical posting, and an already closed receipt retries it. This is intentionally not an all-or-nothing transaction across both phases. See `server/modules/procurement/receiving-orchestration.service.ts:97–143, 153–184` and `receiving.service.ts:996–999`.

### Initial cost and later owners

1. `resolveReceivingLineCost` prioritizes receiving-line mills, then receiving-line cents, then PO mills/cents. PO/storage lookup failure returns unknown rather than throwing. See `receiving.service.ts:313–385`.
2. Before posting, close asks shipment tracking for a finalized landed cost by **PO line only**, even when the receipt has a different shipment ID or no shipment ID. A returned value supersedes receiving/PO cost. The storage query is `WHERE purchase_order_line_id = ... LIMIT 1` without shipment filtering or ordering. See `receiving.service.ts:1146–1167`, `server/modules/procurement/shipment-tracking.service.ts:1744–1770`, and `server/modules/procurement/procurement.storage.ts:1234–1236`.
3. The exact plain-PO path computes per-variant product and packaging from PO totals. The alternate path multiplies the resolved base-piece mills by the variant factor. Close passes total and packaging mills to inventory, but does **not** pass a landed mills component. It stores the resolved base-piece cost back on the receiving line. See `receiving.service.ts:1250–1315`.
4. `InventoryLotService.createLot` defaults absent landed cost to zero and places the remainder `total - packaging - landed` in the product layer. See `lots.service.ts:122–151`.
5. Production wiring always supplies the approved-invoice reconciler. Close calls it within the posting transaction, before the later PO receipt reconciliation. See `server/services/index.ts:264–285` and `receiving.service.ts:1344–1363`.
6. `reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction` selects approved/partially-paid/paid invoice lines for an exact PO line. Complete quantity coverage selects quantity-weighted base-piece invoice mills; otherwise it falls back to the PO's unit mills. It invokes COGS with that value as the product component. See `server/modules/procurement/ap-ledger.service.ts:1475–1596, 1627–1636`.
7. `COGSService.reconcileInvoiceVariance` locks affected lots by ascending ID, multiplies the authoritative base-piece mills by each **live** catalog variant factor, preserves the existing packaging and landed layers, and revalues changed lots. Revaluation updates lot layers, cascades the cost to `oms.order_item_costs`, and writes `inventory.cost_adjustment_log` within the transaction. See `server/modules/inventory/cogs.service.ts:568–638, 218–310, 150–201`.
8. Shipment close atomically finalizes allocations/snapshots, closes the header and writes history. It then attempts a separate best-effort lot-cost push; a thrown push failure is logged but does not undo close. See `shipment-tracking.service.ts:735–769`.
9. `pushLandedCostsToLots` reads only lots with `costProvisional = 1` for the shipment. It groups finalized shipment-line freight/duty/insurance/other buckets by PO line, scales by the lot's live catalog factor, preflights every candidate lot, and delegates revaluation to the COGS owner. See `shipment-tracking.service.ts:1582–1737` and `procurement.storage.ts:1283–1288`.

## Confirmed gaps and their conditional failure cases

These are consequences of the inspected execution paths, not assertions that a particular production receipt is wrong.

### 1. Finalized costs can come from the wrong shipment line

The PO-line-only `LIMIT 1` lookup cannot distinguish two shipments for the same PO line. For a PO line appearing on shipment A and shipment B with different freight, receiving B can use A's snapshot. A direct-PO receipt can also use that snapshot because close does not require a matching receipt shipment before lookup. Both the cents and mills methods query independently, so there is no single transactionally captured source version for the returned pair.

Evidence: `receiving.service.ts:1146–1163`; `shipment-tracking.service.ts:1744–1767`; `procurement.storage.ts:1234–1236`.

The push path at least filters the shipment header, but combines all same-PO-line shipment rows into one weighted pool. Distinct line allocations are no longer distinguishable. If one of those lines is finalized and another is not, the presence of a map entry can still allow use of the partial finalized pool: `unfinalizedPoLines` is only consulted when no finalized map entry exists. Evidence: `shipment-tracking.service.ts:1602–1640, 1663–1670`.

Required correction: exact shipment-line-to-receiving-line-to-lot attribution. Missing or conflicting historical identity must produce review-required evidence; never select an arbitrary snapshot or infer identity from SKU, variant, or PO-line uniqueness without proving the full relation.

### 2. Receipt all-in cost is not a stable component contract

When receipt-time shipment lookup supplies a finalized all-in cost, close passes it as `unitCostMills` while omitting `landedCostMills`. Lot creation therefore records the freight portion in the product remainder, with a zero landed layer. A later AP product revalue preserves the zero landed layer and can remove that freight from total cost. The issue is observable with no packaging: product 10,000 mills plus finalized freight 2,000 mills initially becomes product 12,000 / landed 0; PO fallback revaluation replaces product with 10,000, producing total 10,000.

Evidence: `receiving.service.ts:1153–1163, 1270–1294`; `lots.service.ts:122–128`; `ap-ledger.service.ts:1578–1595`; `cogs.service.ts:606–613, 628–633`.

The plain-PO path has a complementary problem: PO unit mills can already include packaging. The receiving fixture's 150-piece PO is $100 product plus $18 packaging, with blended 7,867 mills per piece. Close initially creates a 50-piece lot with total 393,333 mills and packaging 60,000. AP's no-invoice fallback treats `7,867 * 50 = 393,350` as **product**, then preserves and adds packaging 60,000, yielding 453,350. The exact receiving test currently stops at the inventory call and does not execute the real AP/COGS owner.

Evidence: `receiving.service.ts:1250–1268`; `server/modules/procurement/__tests__/unit/receiving-mills.test.ts:494–529`; `ap-ledger.service.ts:1503–1508, 1578–1585`; `cogs.service.ts:606–613`.

Required correction: explicit product, packaging, and landed base-piece/lot-unit components with one named authority for each; `total = product + packaging + landed` must hold before and after AP and freight updates. An all-in cost cannot be silently used as the product component. PO total and quote precision must remain authoritative rather than reconstructing product value from an already rounded blend.

### 3. Product reconciliation can erase unfinished freight state

`revalueLotCostMills` clears `cost_provisional` unless `clearProvisional === false`. Invoice reconciliation does not set that option. Whenever its product-cost comparison causes a revalue, it can clear the pending-freight marker. The next shipment push selects only provisional lots and will exclude that lot. This is conditional: unchanged product/total costs skip revaluation, so not every AP replay clears the flag.

Evidence: `cogs.service.ts:289, 620–633`; `procurement.storage.ts:1283–1288`. Schema intent is explicitly “landed cost not yet finalized”: `shared/schema/inventory.schema.ts:919–920`.

Required correction: product/AP reconciliation must preserve freight completion state. Clear a freight-pending marker only when the exact freight source/version has been successfully applied. A single blended `costSource` label should not substitute for independent component provenance.

### 4. Historical unit conversion is re-read from mutable catalog data

Receipt lot cost, later PO posting, reversals, invoice revaluation, and landed push each independently read the live variant factor. Reversal subtracts `qty * live factor` and clamps the PO tally to zero, so it can disagree with the original base-piece receipt snapshot after a configuration change. The lot layer contains no immutable factor to recover what its stored variant quantity meant at receipt.

Evidence: `receiving.service.ts:1238–1241`; `purchase-order-receipt-reconciliation.service.ts:224–243`; `server/modules/procurement/receipt-reversal.service.ts:496–510, 611–641`; `cogs.service.ts:583–606`; `shipment-tracking.service.ts:1680–1687`; `shared/schema/inventory.schema.ts:903–955`.

Quantity correctness also requires compatibility with inventory's live balance interpretation: `ATPService.getAtpBaseByWarehouse` computes `variant_qty * product_variants.units_per_variant` at query time (`server/modules/inventory/atp.service.ts:287–309`). A frozen receipt factor by itself cannot make a changed live catalog variant represent a different physical pack in the inventory ledger. W02a must reject configuration drift before posting and preserve the receipt snapshot for later history. Global post-receipt catalog pack mutability needs a separately proven policy; it is not solved by this document.

### 5. Finalization is not equivalent to every lot having the final cost

The post-close lot push is separate from the close transaction. Missing mappings return `{ updated: 0, skipped: [...] }` rather than throwing; close ignores that return value. Therefore a closed shipment is not proof that inventory/COGS received its costs.

Evidence: `shipment-tracking.service.ts:759–769, 1695–1699`. The current atomic-close PostgreSQL fixture explicitly substitutes an empty lot list and does not prove the inventory phase (`server/modules/procurement/__tests__/integration/shipment-cost-commands.integration.test.ts:433–435`).

Standalone finalization can replace changed snapshots and record an adjustment, but the push still selects only provisional lots. Already-finalized lots do not automatically become candidates just because the source snapshot changed. Evidence: `shipment-tracking.service.ts:1433–1436, 1517–1573`; `procurement.storage.ts:1283–1288`.

Required correction: an explicit application status/version and retryable owner operation, with a durable pending/failure result distinct from shipment closure. Changed sources must identify all affected lots rather than rely on a provisional-only filter. No claim is made here that every historical cost-edit route can produce a changed source; the direct finalization behavior itself is present.

### 6. Snapshot totals lose precision before display rounding

Allocation/finalization uses PO `unitCostCents * qtyShipped` rather than authoritative PO total/mills values. The mills receive lookup then reconstructs costs using the **current** PO unit mills plus snapshot buckets. Thus the snapshot cents total and the later reconstructed mills are not one immutable exact valuation source. For the existing test's 375 mills (3.75 cents) base-piece cost, multiplying its rounded 4-cent mirror across quantity cannot reproduce the original product total.

Evidence: `shipment-tracking.service.ts:1028–1053, 1504–1553, 1754–1770`; `shared/schema/procurement.schema.ts:591–619`.

Required correction: source totals and quantities in explicit units, integer/decimal arithmetic, deterministic remainder handling, and one captured source version. Preserve existing snapshot/history rows; do not rewrite historical economics to make new columns look complete.

## Minimum W02a contract that the financial follow-up needs

- Each new shipment-derived receiving line must retain exact `inboundShipmentLineId`, existing `purchaseOrderLineId`, selected `productVariantId`/product identity, and a positive frozen number of base pieces per receiving unit. The relationship must be validated against the receipt shipment and PO; IDs must not merely be accepted because the rows independently exist.
- Expected, received, damaged, and reversed quantities must have an explicit receiving-unit basis. Base-piece projections must use the frozen factor exactly once, with safe integer bounds. If derived base totals are persisted, enforce their consistency with quantity and factor rather than allow a second editable authority.
- Preserve the exact receiving-line/lot proof already written by `receiveInventory` in inventory transactions. A future owner may add a direct immutable lot source/factor projection; until then it must resolve an exact, non-conflicting receipt transaction rather than join by product or variant.
- Cost fields currently stored on receiving lines remain base-piece costs; lot fields remain per receiving-variant unit. W02a must not silently reinterpret historical `unitCostMills` while introducing a quantity snapshot.
- The selected W02a policy—preferred active same-product variant when quantity divides its recorded factor, otherwise an active one-piece variant for the entire receiving line—avoids inventing carton contents. It preserves total pieces without asserting full/loose carton composition. It records stock in the one-piece variant for that receipt and therefore does not preserve full-case inventory granularity for that partial line. This is a known consequence of the chosen representation, not an inferred physical unpacking event.
- Fail with actionable review when no valid existing one-piece variant exists, a source changes before posting, or a historical conversion/link is unknown. Do not fabricate a variant from `qtyShipped / cartonCount`, round up pieces, or backfill old history from today's catalog.

A source-cost version is required for the later financial application command, not for W02a's physical quantity identity. That version should identify the exact finalized shipment-line allocation inputs, PO/invoice component evidence, denominator, and already-applied lot version. A pointer to a mutable/deleted snapshot row alone is insufficient because current finalization deletes and replaces snapshots (`shipment-tracking.service.ts:1568–1572`).

## Coherent financial follow-up and compatibility boundary

Implement source selection, component decomposition, and application state together. Fixing only the PO-line lookup would still let AP remove freight; fixing only components would still allow another shipment's cost; fixing only the pending flag would still apply a cost with an uncertain unit basis.

Proposed invariants:

1. One exact source graph per lot: receipt line → shipment line (when applicable) → finalized allocation evidence; PO/invoice product evidence remains separately identified.
2. One immutable receive-unit factor for historical calculations, with no live catalog fallback for new stamped receipts/lots.
3. Product updates preserve packaging, freight, and their application states. Freight updates preserve the current authorized product and packaging layers.
4. Every application is an idempotent, versioned owner command that locks the complete affected scope, validates all mappings before any revalue, and commits lot layers, COGS cascade, and audit together. Existing atomic lot revaluation and batch preflight should be reused.
5. New inputs fail closed for ambiguity. Legacy history stays readable; a narrowly authorized review/correction operation may establish missing evidence, but this slice must not infer or rewrite it silently.
6. Receive-before-finalize and finalize-before-receive converge to the same component costs for the same quantity/source evidence. Invoice approval before or after either event must also converge.

Unknown policy requiring an explicit decision before implementing the financial command: treatment of a genuine manual receiving-cost override when approved invoice evidence exists; whether invoice product unit prices include separately recorded packaging; allocation of shipment costs when less than the shipped quantity is accepted or some goods are damaged; signed freight credits (existing negative allocation rejection is not fixed here); and representation/approval of historical corrections. The present code alone does not establish the intended business answer.

## Test coverage and required proof

Inspected existing coverage:

- `server/modules/procurement/__tests__/unit/receiving-mills.test.ts` verifies source priority, exact plain-PO case costing, finalized-cost inputs, provisional flags, and that the injected AP callback executes/fails in the posting transaction. Its AP callback is mocked (`:262–299`); it does not prove combined real AP/lot component results.
- `server/modules/procurement/__tests__/unit/ap-ledger-approved-cost-reconciliation.test.ts` verifies approved coverage, weighted prices, final received quantity, and excluded invoice statuses.
- `server/modules/inventory/__tests__/unit/lot-cost-populated.test.ts` verifies component population for the parameters supplied to lot creation.
- `server/modules/inventory/__tests__/unit/invoice-variance-reconcile.test.ts` verifies scaling, exact mills, transaction reuse, no-op detection, and rollback on later-lot failure.
- `server/modules/inventory/__tests__/integration/invoice-variance-cogs.integration.test.ts:156–342` proves real lot/COGS revaluation, exact PO-line isolation, different receiving variants and rollback. Its mixed variants have distinct current catalog factors (`:262–309`); it does not test catalog drift or a frozen receiving factor.
- `server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts:258–285, 557–750` verifies PO-line lookup, push preflight, owner failure and close-triggered push. The PO-line grouping is current behavior, not exact shipment-line attribution proof.
- `server/modules/procurement/__tests__/integration/shipment-cost-commands.integration.test.ts:415–504` proves procurement close locking and rollback but deliberately has no inventory candidates.
- `server/modules/procurement/__tests__/unit/receiving-semantics.test.ts:354–552` verifies replay and visible post-commit PO reconciliation failure.

Required new unit and disposable-PostgreSQL scenarios for the financial slice:

1. One PO line on two shipments with different costs; two rows on one shipment for the same PO line; an unfinalized sibling row; missing/conflicting legacy source IDs. No cross-source valuation is allowed.
2. Both event orders: receive → invoice → freight, and freight → receive → invoice. Exercise real receiving, inventory lot, AP and COGS owners, with nonzero packaging and freight, then compare exact layers and final totals.
3. Pending freight survives a changed AP product cost. A later freight retry applies exactly once and only clears the matching pending state.
4. Preferred packs and whole one-piece fallback quantities produce identical base-piece totals. Catalog changes after receipt do not alter historical PO/reversal/cost calculations; new posting rejects stale configuration.
5. Non-dividing source totals retain deterministic residuals; null cost evidence is not fabricated as zero; bounds and signed-credit policy are exercised explicitly.
6. A changed finalized source revalues already-finalized affected lots once, retaining immutable prior evidence and a traceable adjustment.
7. Concurrent receive/close/AP/freight requests use a proven lock order; mid-batch mapping, lot, COGS or audit failure rolls back the whole financial application; durable retries do not double-post quantities or costs.

Audit execution: after the worktree dependency junction was corrected, the five focused unit suites for receiving mills, approved invoice reconciliation, shipment landed costs, lot cost population, and invoice variance passed **60/60 tests** on 2026-09-06. The initial attempt failed before tests started because `vitest/config` was unavailable; that environment issue was resolved. The PostgreSQL coverage descriptions above come from reading the actual tests; current disposable PostgreSQL execution has not been performed by this audit task. Passing the existing isolated suites does not prove the combined-path invariants listed above.
