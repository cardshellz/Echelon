# Procurement cost application: invoice, packaging, overrides, and descendants

Status: baseline audit plus one implemented containment fix: metadata-only invoice-line updates preserve recorded financial fields. Remaining cost-authority proposals are not implemented. No production financial-data changes.

Audit checkout: `codex/procurement-cost-application`, baseline `d836adc228897ca16f0dbb2416d15a2f7e6a36db`, 2026-09-06. The evidence sections and source line references below describe that baseline; the final implementation section identifies the bounded change and its validation. The earlier `procurement-receiving-cost-followup.md` is useful context, but its blended PO unit-price example is not the current new-PO pricing contract. Historical rows must not be reinterpreted from the current calculator.

## What the code definitely does

### 1. Current PO product price and packaging are distinct inputs

`server/modules/procurement/purchasing.service.ts`, `calculateLineCosts`, lines 508–590:

- With `totalProductCostCents`, product-only unit mills are derived from `totalProductCostCents * 100 / orderQty`, using signed integer rounding (529–547). Packaging is separately added to the subtotal (531–534).
- Discount and tax apply to that product-plus-packaging subtotal (573–584).
- In the compatibility input shape, unit cost is the source and packaging becomes zero (548–570).
- The schema records exact product and packaging totals, pricing provenance, and a signed pricing remainder (`shared/schema/procurement.schema.ts`, `purchaseOrderLines`, 597–625). `pricingBasis = legacy_unknown` explicitly does not prove whether historical unit fields used current semantics.

Therefore a current generated PO's unit mills must not be treated as an all-in price. A historical row with different provenance must not automatically be rewritten to the new interpretation.

### 2. Receipt generation copies that product-only price, but receipt close still expects a blend

`createReceiptFromPO` is public at purchasing.service.ts:3204 and delegates to `createReceiptFromPOUnlocked`; its line builder copies PO mills/cents at 3323–3354. `createReceiptFromShipment` does the same at 4095–4128. W02 correctly stamps the receiving unit factor and exact shipment line, where applicable.

`server/modules/procurement/receiving.service.ts`:

1. `resolveReceivingLineCost` returns immediately for receipt mills or cents, without packaging components (324–340). These fields contain both generated PO prices and user overrides; no provenance distinguishes the two.
2. The PO fallback returns separate packaging only when receipt prices are absent (350–383).
3. `close` compares the resolved cost to `(PO product total + packaging total) / PO quantity` (1391–1403). Only equality selects its component-preserving totals path (1404–1409).
4. Otherwise total lot cost becomes resolved unit mills times the frozen receive factor, and packaging comes from the optional resolver output (1410–1415).
5. It passes total and packaging to `receiveInventory`, but no landed component (1419–1435).

**Current-source failure, with explicit fixture conditions:** PO 150 pieces, product 10,000 cents, packaging 1,800 cents, no typed adjustments, no shipment cost override, receipt in packs of 50. Current normalization produces 6,667 product mills. The generated receipt copies 6,667; its resolver returns no packaging; the blended comparison is 7,867, so the alternate path produces 333,350 total mills per pack and zero packaging. Three packs carry 1,000,050 mills ($100.0050), rather than the $118 source total. The omission and rounding are code-path consequences; production incidence is not established.

**Separate historical case:** if stored PO and receipt mills are 7,867, the existing exact branch initially yields 333,333 product plus 60,000 packaging = 393,333 mills per pack. Subsequent AP fallback treats stored 7,867 as product and adds existing packaging again: 453,350 mills per pack. This is conditional on actual historical blended data, not the current calculator's output.

### 3. Invoice amounts do not have a recorded packaging basis

`server/modules/procurement/ap-ledger.service.ts`, `importLinesFromPOWithClient` (2596–2668):

- Copies PO product-only unit mills/cents (2637–2640).
- Copies the stored full PO line total, which can include packaging, discount, and tax (2642–2661).
- No component or residual fields accompany those two prices.

`vendorInvoiceLines` (`shared/schema/procurement.schema.ts`, 1804–1824) contains quantity, unit mills/cents, and line total, plus PO/freight links. It has no product-versus-packaging basis, packaging actual, source component totals, tax/discount components, or economic revision field. AP UI labels the value simply `Unit Cost` / `Unit Cost ($)` (`client/src/pages/APInvoiceDetail.tsx`, 699, 1026–1027).

Manual `addInvoiceLine` validates a nonnegative unit price and derives the line total from quantity times that price (ap-ledger.service.ts:2735–2755). This is a different amount construction from import. Neither schema nor UI proves how the vendor intended an entered price to treat packaging.

**Baseline policy-independent mutation defect (contained by the implementation below):** `updateInvoiceLine` always recalculates quantity, unit price, and line total (2867–2885), even if the only supplied field is `notes` or `description`. It then recalculates the invoice header from line totals (2899; `recalculateInvoiceFromLines`, 2982–3012). For the above PO, import produces a $118.00 invoice line with unit mills 6,667 and quantity 150. A notes-only edit changes that line and invoice contribution to $100.01. This drops the unexplained residual without an economic request. It also changes `matchStatus` to pending. The exposed caller is `PATCH /api/vendor-invoice-lines/:lineId` with purchasing/edit permission (`ap-ledger.routes.ts:242–252`). No current `APInvoiceDetail.tsx` PATCH notes editor was found; this is an API mutation defect, not a claim about a UI editor.

### 4. Approved-invoice reconciliation writes only the lot product layer

`approveInvoiceInTransaction` locks the invoice, transitions eligible received/disputed invoices to approved, recomputes PO financial aggregates, and invokes reconciliation in the same transaction (ap-ledger.service.ts:1391–1430). Reapproving an already approved/partially-paid/paid invoice also reconciles (1404–1409).

`reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction` (1475–1659):

1. Locks the exact PO line and reads its unit price (1481–1508).
2. Loads invoice lines for that PO line and accepts invoices in approved/partially_paid/paid status (1509–1543).
3. Uses quantity-weighted unit mills only when approved quantity exactly equals the coverage denominator (1544–1596). The denominator is received quantity for received/closed PO lines, otherwise ordered quantity (1567–1573).
4. Missing or incomplete approved quantity selects PO unit-price fallback, not a per-receipt/invoice allocation (1578–1585).
5. It does not read invoice line totals or packaging components. It calls `COGSService.reconcileInvoiceVariance` with that unit price and source `invoice` or `po` (1627–1636).

`server/modules/inventory/cogs.service.ts`, `reconcileInvoiceVariance`:

- Selects lots by exact `purchase_order_id + po_line_id` (568–590), including transferred lots whose header links survive.
- Reads **current catalog** `units_per_variant` (583–585), scales price by it (601–610), and treats the result as the lot product component.
- Preserves existing packaging and landed components (611–614, 628–633).
- Does not filter or protect explicit manual receipt costs, and does not read receipt source prices.

`revalueLotCostMills` locks each lot, writes product + packaging + landed = total, updates cents mirrors, and cascades to `oms.order_item_costs` in the caller's transaction (207–294). It records a cost adjustment log (296–310). The cascade updates existing COGS rows by lot ID (150–204). These are real transactional protections, but they do not prove the selected price components or unit factor are correct.

**Remaining W02 boundary:** receipt close uses `unitsPerVariantSnapshot` (receiving.service.ts:1381), but later AP revaluation uses live catalog factors. If a received pack was frozen at 50 pieces and the catalog factor later becomes 100, the same per-piece price is doubled on the original lot during AP reconciliation. W02 did not make that later writer use the frozen factor.

**Coverage policy still unknown:** exact whole-line quantity coverage is an implemented policy. Whether a partially invoiced shipment should receive actual cost independently, and how shortages/damage credits should affect the denominator and recoverable value, require business decisions. A sum matching the denominator does not establish a mapping from each invoice line to each receipt.

### 5. Manual receiving cost fields are not a durable override authority

`Receiving.tsx:2651` explicitly describes CSV `unit_cost` as price per piece. The backend CSV reader parses it to mills/cents and writes receipt fields (`receiving.service.ts`, import code 1880–1940). `updateLine` permits cost fields and validates supplied non-null values as nonnegative integers (974; 1083–1086).

At close:

- Explicit receipt price wins the initial resolver (324–340), but a shipment landed lookup can replace it (1289–1306), and a typed PO adjustment can replace it (1336–1370).
- Receipt close then invokes the AP reconciler for every received PO line, even if there are no approved invoices (1485–1492).
- Production wiring supplies that real reconciler (`server/services/index.ts`, 278–287). PO receipt reconciliation happens after receipt posting commits (receiving.service.ts:1517–1518).
- The AP fallback ignores the explicit override and sets lot product to PO unit cost. `InventoryLotService.createLot` labels any linked lot as `po` by default, not manual (lots.service.ts:154–162).
- The receiving line still stores its resolved per-piece price (receiving.service.ts:1440–1456), and `resolveReceiptUnitCosts` records it as actual receipt cost (`purchase-order-receipt-reconciliation.service.ts`, 373–396).

**Deterministic divergence:** a linked receipt with explicit $1.2345 per-piece cost, PO $1.0000, no invoice and no packaging/freight posts a $1.2345 lot, then the in-transaction AP fallback changes lot/COGS product to $1.0000. The receipt and PO receipt allocation can retain $1.2345 as actual cost. Which source ought to win is not established by the data model; the divergence is established by these calls.

The CSV price parser also treats an invalid price as a warning and falls back to null/cents rather than rejecting the entire row (1882–1897). A blank cost on a matching SKU/location can replace existing cost fields with null (1907–1920). These behaviors need an explicit preserve/clear/replace import contract before expanding override controls.

### 6. Product revaluation can incorrectly finish pending freight

`revalueLotCostMills` clears `cost_provisional` unless explicitly passed `clearProvisional: false` (cogs.service.ts:289). Invoice reconciliation does not supply that flag (628–633). It clears the marker only when a revalue actually occurs; unchanged-cost no-ops skip it (620–622).

`InventoryLotService.createLot` defaults landed to zero and computes product as total minus other components (lots.service.ts:122–128). Therefore an all-in shipment value passed as receipt total without a landed layer is initially classified as product. AP later replacing product can remove its freight amount. This follows from receiving's omitted `landedCostMills` argument (1419–1435), not from an absence of such an argument in the inventory API (inventory.use-cases.ts:229–230 forwards it when supplied).

A single final/provisional flag does not independently express product quote vs invoice actual, packaging pending, and freight pending. A product-only update must not certify the other components.

### 7. Transfer and transformation descendants have different evidence

| Path | What is preserved | What current AP can reach / cannot prove |
| --- | --- | --- |
| Receipt | Immutable receipt transaction contains `receiving_line_id` and `inventory_lot_id` (`inventory.use-cases.ts`, 245–264). | Original lot can be mapped to frozen receipt units through that transaction. Lot itself has receipt header, PO line, and shipment header only. |
| Warehouse transfer | `InventoryLotService.transferLots` keeps one output lot per consumed layer, all three costs, original receipt date, PO/line/receipt/shipment headers and provisional state (816–940). | AP PO/line query reaches outputs. Source lot ID exists only in the local `layers` object (865); `createLot` at924–940 does not persist source-lot or exact receipt-line identity. A shared receipt header is not proof of a unique unit/source row. |
| Direct break/assembly | `BreakAssemblyUseCases.breakVariant` and `assembleVariant` consume FIFO cost then pass rounded per-target **cents** into generic adjustment (199–224, 303–328). | Generic `adjustLots` creates an output lot without components or procurement source links (lots.service.ts:679–692). AP cannot reach that output by PO/line. Cost precision and component identity were also discarded during conversion. |
| Replenishment case break | `InventoryUseCases` uses exact component totals, `allocateBuildCostLayers`, and a propagated provisional flag (1523–1545). | Output lot has `costSource: transformation`, but no source-lot or PO/receipt/shipment fields; transaction pair refers to the replenishment task only (1548–1577). Current AP query misses it. |
| Versioned build run | `BuildExecutionRepository` records source lot ID, consumed quantity, and component mills in `build_run_consumptions` (636–645); output lots retain `build_run_id` and components (739–763). | There is source-to-run-to-output evidence for a future recost graph. Current AP doesn't traverse it. Build outputs are written with `cost_provisional = 0` (761) irrespective of the input marker; inherited uncertainty is not represented there. |

This is not evidence that all descendants can safely be recosted today. Transfers need exact source lineage persistence; legacy break outputs may have insufficient evidence; build outputs need an explicit deterministic downstream adjustment algorithm using immutable consumption records. A shipment-only patch must not claim complete downstream COGS coverage.

### 8. Signed credits must be preserved, with the existing incompatibilities explicit

`getShipmentCostPaymentStatus` deliberately accepts signed cost amounts and allocates partial payment across them (ap-ledger.service.ts:3800–3836). `shared/procurement/shipment-cost-command.ts:13` documents the signed source contract.

The other paths do not uniformly support those credits: shipment-to-invoice generation validates each cost as nonnegative (ap-ledger.service.ts:3638–3643); invoice unit-price normalization is nonnegative (176–198); `revalueLotCostMills` requires each component to be nonnegative (cogs.service.ts:256–261). Do not “fix” this mismatch by converting, dropping, or clamping signed charge records. Source credit allocation, net component rules, and admissible net inventory value must be explicit. The existing `Math.max(0, remainder)` in lot creation (lots.service.ts:128) is not a proof of component conservation.

## What is likely happening

HYPOTHESIS: operators can see receipt actual prices, inventory values, and invoice totals disagree after an apparently unrelated edit or approval because each owner interprets shared unit fields differently. The deterministic examples above establish available failing paths, not which path any particular production record has taken.

HYPOTHESIS: historic mixed pricing conventions may coexist because the schema deliberately keeps `legacy_unknown` provenance. A read-only classified inventory of records is required before proposing historical repairs.

## What is not proven

- Whether a particular vendor quotes product separately from packaging, bundles it into unit price, adds it as a separate invoice charge, or varies between documents.
- Whether explicit receiving prices are intended as final overrides, provisional estimates, damaged-unit values, or transcription helpers.
- Whether short/damaged goods are supplier credits, freight claims, insurance recoveries, replacements, or retained inventory/write-off events; when entitlement is recognized; and what quantity/cost denominator is intended.
- Production frequency, historical financial impact, invoice currency correctness for older links, or the existence of enough lineage to repair every transformed lot.
- That invoice approval means all receipts, packaging, freight, duty, and other costs are final. The code does not encode that guarantee.

These unknowns must remain visible and must not be resolved by inferring the meaning of a numeric residual.

## Smallest coherent corrective design (proposal, not implemented)

### A. Policy-independent containment and exact reads

1. **Implemented below:** make metadata-only invoice edits preserve quantity, unit prices, line total, and matching evidence. Test notes and description against an imported line with a nonzero residual. Do not recompute money merely because any field was patched.
2. Introduce a pure cost-source resolution result used by receipt posting and AP application: exact source references, component scope, currency basis, integer source total/denominator/remainder, frozen unit factor, and typed blockers. Keep source data distinct from rounded display unit prices.
3. For new proven PO prices, derive product and packaging independently from their exact totals. Do not determine source identity by equality with a blended unit price. Preserve component remainders across lots so source total reconciliation is exact, rather than only cent-display exact.
4. Reuse original receipt transaction -> receiving-line snapshot to resolve each original lot's unit factor. Persist that source identity on new transfer descendants. Where lineage or factor is ambiguous, return a review blocker; never fall back to the current catalog factor.
5. Product-only application must preserve packaging/landed amounts and their pending state. Replace a global finality implication with component/source completion evidence, or at least avoid clearing freight pending during AP product updates until that richer contract exists.

### B. Explicit invoice and manual-price authority before economic application

Proposed invoice evidence records should identify source document/revision and distinguish product total, packaging total, signed adjustments, quantity basis, currency, and any unresolved difference. A manually entered `Unit Cost` is insufficient. A full document amount and its allocation to this PO/receipt must remain separate.

For an imported current PO draft, source provenance can explain its copied product/packaging/discount/tax components; that is a draft expectation, not proof of the vendor's actual invoice. Confirmed invoice entry must explicitly establish which components the vendor billed. Historical unknown rows remain unknown until reviewed. Do not deduce packaging by `lineTotal - quantity * unitPrice`: that residual can include discounts, tax, and rounding.

Proposed receipt override record: explicit component (`product`, `packaging`, or all-in with a supplied breakdown), reason, actor, source document, reviewed basis, revision, and whether superseded by invoice actuals. Generated PO-copy fields must never masquerade as overrides. The business answer determines replacement policy; until then, conflicting explicit sources should be blocked for review rather than silently overwritten.

Partial invoice coverage needs either exact invoice-to-receipt/PO quantity allocations or a stated conservative pending policy. Do not convert an unknown allocation into whole-PO actual cost merely because quantities sum equally. Keep any damage/short recovery claim outside this cost decision until its source and accounting policy are defined.

### C. One atomic, replayable application after source review

A cost application should carry a deterministic key for source revision + target component + target lineage/version, lock source and affected lots/COGS in a documented common order, calculate a reviewable before/after plan, and atomically persist component changes plus immutable application evidence. A retry must return the same result; a changed source creates a new revision, not a second application of the previous delta. Signed source credits remain signed in the allocation evidence; unsupported net outcomes produce explicit errors.

The first safe application can target original, exactly mapped receiving lots and fully proven transfer descendants. Build/case-break descendants must either be supported by an audited dependency graph or reported as a completeness blocker. Do not update a subset and mark the source wholly applied. Keep historical repair as a separate dry-run and explicitly authorized action.

## Tests needed and existing coverage limits

Existing `receiving-mills.test.ts:495–530` uses a historical blended fixture and asserts captured inventory arguments. It does not execute real lot creation followed by AP reconciliation. Its override tests similarly establish initial receiving behavior, not durable override preservation. `ap-ledger-approved-cost-reconciliation.test.ts:42–44` mocks `reconcileInvoiceVariance`. Existing `invoice-variance-cogs.integration.test.ts` proves COGS updates and transaction rollback in its isolated schema, but seeds lot layers directly; it does not run current PO generation -> receiving -> AP together.

Required combined proof:

1. Current normalized PO 150 pieces / $100 product / $18 packaging, received as 3 packs of 50: exact product/packaging/total conservation through generation, close, AP fallback, full invoice, and replay. Keep a separate historical blended fixture; never substitute it for current pricing.
2. Invoice imported from PO with packaging/discount/tax/rounding residual: notes/description edits preserve all economics; economic edits require explicit resolved components.
3. Product-only and packaging-inclusive invoice cases once the policy is confirmed; partial invoices, multiple prices, over/undercoverage, void/dispute rollback, short close, and explicit credit allocations.
4. Manual per-piece override stays visible and is either applied under the selected authority policy or blocks a conflicting application; receipt, lot, PO receipt evidence, and COGS never silently diverge.
5. Invoice-before-receipt and receipt-before-invoice; freight-before/after-invoice; source revision/replay; unchanged product must not certify pending freight.
6. Frozen receive factor 50 with catalog later changed to 100: AP uses 50 or blocks ambiguous historical provenance; transfers, repeated receipt lines, deleted/inactive variants, and missing lineage are covered.
7. Direct original lot, warehouse transfer, direct break, replenishment break, versioned build, second-generation descendant, and sold descendant COGS. Assert supported propagation or explicit completeness blockers, not silent omission.
8. Signed promotion/credit with positive net source; zero genuine cost versus unknown; deterministic signed rounding, exact remainders, safe integer overflow, and invalid negative net outcomes.
9. Real PostgreSQL concurrent receipt close/AP approval/freight revision/application, source drift, deterministic lock order, second-lot failure rollback, and lost-response same-key retry. No partial money or completion marker commits.

## Implemented containment: metadata-only invoice updates

Only `ap-ledger.service.ts:updateInvoiceLine` and a dedicated unit test were changed at runtime. Existing invoice status restrictions, invoice/PO/line lock order, transaction, HTTP permission check, and event naming are retained.

- Supplied quantity/cents/mills must be JSON numbers and safe integers (positive quantity, nonnegative price); null, boolean, string, fractional, nonfinite, and unsafe values reject before the transaction. If supplied economic values are unchanged, the command preserves all recorded economic fields. This includes rounded cents-only echoes of a sub-cent price, unchanged inconsistent legacy mirrors, and explicit numeric mills equivalent to legacy cents while stored mills remain null.
- A metadata-only command never normalizes legacy economic fields: null mills, stale cents mirrors, zero values, and signed credits remain exactly recorded. It does not reset match status, recalculate the invoice header, recompute linked PO financial projections, or run their detection hooks.
- An actual quantity/price change retains the existing normalized repricing behavior. This containment deliberately does not classify or reconstruct packaging/discount/tax residuals for that economic path.
- The existing transaction writes an audit event with actor, `economicsChanged`, supplied metadata before/after, and exact economic before/after snapshots (quantity, cents, mills including null, line total, and match status). Economic evidence is copied from the locked existing row and returned persisted row, not reconstructed. `updatedAt` uses the existing orchestration clock; no new clock or hidden helper state was introduced.

Validation by this author: `npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-metadata.test.ts server/modules/procurement/__tests__/unit/ap-ledger-editing-validation.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts --maxWorkers=2` passed **3 files, 42 tests**, including 31 new metadata/boundary cases. Coverage includes imported total preservation, null/stale mirrors, signed credits, zero stored values, unchanged price/quantity echoes, actor/before/after audit, immutable approved invoices, invalid changed price mirrors, strict raw JSON number validation, and the retained economic path. `git diff --check` and final `npx tsc --noEmit` passed. The independent PostgreSQL owner ran `server/modules/procurement/__tests__/integration/ap-invoice-line-metadata.integration.test.ts`: **11/11 passed** against the final strict boundary and audit implementation. Those cases exercise real `updateInvoiceLine`, schema-derived tables and linked PO/invoice records; metadata and unchanged numeric echoes preserve financial rows, malformed numeric inputs are atomic rejections, audit persistence failure rolls back, and a blocked update sees a concurrent approved status and rejects. The fixture seeds imported-like 150/6,667/11,800 economics; it does not execute the invoice import command itself. Broader cost characterization is recorded separately in `procurement-cost-test-proof.md`.

Assumptions: none about vendor invoice packaging semantics or recovery policy. Unchanged or exactly equivalent prices mean no economic intent for this API, so this patch preserves exact stored values rather than performing a repair. A caller intending to replace a sub-cent price with its coincidentally equal rounded cent mirror must supply the intended mills price; a cents-only echo is preserved.

Risks and failure modes: raw numeric strings previously accepted through coercion now reject according to the numeric DTO; explicit JSON null cannot clear a price. Legacy inconsistencies remain visible instead of being silently repaired; actual economic edits still use the earlier repricing policy and can discard an unclassified residual. Those changes require the larger component contract. Metadata stays blocked for invoices outside received/disputed and for broken linked-PO integrity, as before. A failed audit insert rejects the transaction; the independent PostgreSQL test proves the line metadata and timestamp roll back with it. No production database reads or writes were performed by this author.
