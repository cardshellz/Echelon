# Procurement cost application: current findings and proposed contract

Baseline inspected: `d836adc228897ca16f0dbb2416d15a2f7e6a36db`, merged PR #1387. Deployment was reported by the user; this review does not establish the state of the production database or migration 221. The investigation uses a separate worktree and synthetic disposable PostgreSQL records.

This follows the receiving quantity/source slice. The older [receiving cost audit](procurement-receiving-cost-followup.md) is historical evidence, not the current PO pricing contract. The [invoice trace](procurement-cost-invoice-trace.md), [shipment/descendant trace](procurement-cost-shipment-trace.md), and [test proof](procurement-cost-test-proof.md) provide the detailed sources and execution results for this review.

## What the code definitely does

### Current product prices and packaging are separate, but receipt cost resolution is not

`PurchasingService.calculateLineCosts` normalizes **product-only** unit mills from `totalProductCostCents`; packaging is an independent exact-cent total (`server/modules/procurement/purchasing.service.ts:529–547`). The quote constraint also records a pricing remainder and defines the line total as product plus packaging minus discount plus tax (`shared/schema/procurement.schema.ts:774–799`).

Generated receiving lines copy those product-only unit mills (`purchasing.service.ts:3323–3338`). `resolveReceivingLineCost` returns immediately when a receiving line already has mills, before reading PO packaging (`receiving.service.ts:325–350`). Close's exact component path instead tests equality with a **blended** product-plus-packaging unit price (`:1395–1417`). A current product-only price with nonzero packaging takes the alternate path, whose absent packaging input is zero. The older blended-price example therefore does not cover the ordinary current source shape.

The confirmed consequence is a source-contract mismatch, not a measurement of affected production inventory. Synthetic execution and exact observed amounts are recorded separately in the test proof.

### Source identity, component authority, and application completion are still coupled incorrectly

- Receiving asks for landed cost by PO line, not exact shipment line; the storage lookup is `LIMIT 1` (`receiving.service.ts:1289–1306`; `procurement.storage.ts:1234–1236`). A split purchase can select another shipment's snapshot. Direct PO receiving calls this lookup too.
- Close supplies an all-in lot price without supplying a landed component (`receiving.service.ts:1410–1435`). Lot creation treats the remainder after packaging and landed as product (`inventory/lots.service.ts:122–149`). AP later replaces product and preserves the stored packaging/landed components (`inventory/cogs.service.ts:606–634`). Freight placed in product can disappear during that replacement.
- Invoice reconciliation uses live catalog units and clears the shared provisional flag when it changes a lot (`cogs.service.ts:583–606, 628–634`; default clearing at `:289`). Freight application selects only provisional lots (`procurement.storage.ts:1283–1288`). A changed product price can therefore remove a lot from the later freight batch.
- Shipment closure commits before a separate best-effort push to inventory. Returned skipped records are not included in the close result (`shipment-tracking.service.ts:734–769, 1695–1699`). Closure alone cannot establish completed cost propagation.
- Finalized snapshots can contain estimated charges; allocation uses `actualCents ?? estimatedCents ?? 0`, while the finalization gate checks dimensions/status rather than final actual amounts (`shipment-tracking.service.ts:973, 1444–1471`). “Finalized” currently describes an allocation action, not necessarily final vendor evidence.

### Warehouse transformations are part of procurement cost correctness

Original receipt transactions prove an exact receiving-line/lot pair (`inventory/application/inventory.use-cases.ts:166–185, 212–264`). The new receiving-line unit snapshot protects the original quantity interpretation. It is not yet a complete cost lineage graph.

Transfers copy PO/receipt/shipment headers and cost layers but lose the input/output lot edge (`inventory/lots.service.ts:819–940`). Legacy break/assembly passes rounded cents through generic adjustments and loses component/source evidence (`inventory/application/break-assembly.use-cases.ts:179–226, 284–335`). Build execution retains input lot and component snapshots plus output build-run identity, but outputs are marked nonprovisional and later AP/COGS does not traverse those edges (`inventory/infrastructure/build-execution.repository.ts:633–645, 711–778`; `inventory/cogs.service.ts:150–204, 583–589`).

A cost repair limited to the original receipt lot would miss known downstream paths. Historical source gaps cannot be resolved from matching SKU, PO line, adjacent timestamps, or similar quantities.

### An independent invoice edit defect can be repaired immediately

At the inspected baseline, `importLinesFromPOWithClient` preserves the full PO line total while copying product-only unit mills (`ap-ledger.service.ts:2637–2661`). `updateInvoiceLine` always reconstructs the line total from unit price times quantity, including requests that change only notes or description (`:2867–2899`). That can remove recorded packaging/discount/tax or amplify an existing pricing remainder.

The bounded runtime repair in this worktree preserves recorded economics and match status for metadata changes. Financial recalculation remains attached to actual price/quantity changes. It does not classify historical residual amounts as packaging or claim to solve the wider cost pipeline. See the invoice trace and test proof for final behavior and validation.

## What is likely happening

HYPOTHESIS: different event orders and warehouse movement paths can make apparently similar purchases produce different recorded cost components. The branch conditions above support that risk; they do not establish which production purchases followed each path. Synthetic integration scenarios can reproduce a defect without establishing its production prevalence.

HYPOTHESIS: the single closed/provisional indication contributes to the user's difficulty trusting cost status, because a source document's completion and successful downstream application are not represented separately. The existing purchase workspace explicitly says inventory lot history is not linked (`purchase-workspace.service.ts:96–104`). Usability impact beyond the user's report has not been measured.

## Proposed user experience

Add a **Cost trace** to the existing purchase lifecycle workspace, keeping the selected purchase and document context when opening source detail. Use the same context for shipment and receiving entry points. The design proposal shown in the conversation uses illustrative records, not live balances.

The view should answer:

1. **What has been recorded?** Show product, packaging, freight/duty/insurance/other, and separately identified adjustments. Display their currency and quantity basis. Do not add whole shipment or invoice totals to an individual purchase unless an allocation is recorded.
2. **What is still estimated?** Show expected all-in cost separately from booked lot cost. Unknown amounts remain unknown. An approved zero is distinct from a missing invoice.
3. **Where did each amount come from?** Selecting a component opens its exact quote/invoice/charge line, revision, quantity denominator, receipt line, and affected lots in the inspector. Keep original and replacement evidence accessible.
4. **Where did it go?** Show receipt/lot application and sold-order COGS application separately, including transferred or transformed inventory. Mark missing lineage as review required. Do not label an entire purchase complete if only some affected branches are proven.
5. **What needs attention?** Present a concrete next action: obtain a missing invoice, review a source link, retry a failed application, or preview an authorized correction. Ordinary successful application needs no extra operator approval click.

Suggested visible states are `Estimated`, `Awaiting source`, `Ready to apply`, `Applied`, `Retry required`, and `Review required`. They are proposed independent component/application states, not aliases for existing shipment lifecycle statuses. Archon export remains a future integration and must not display as delivered until a real consumer acknowledgement exists.

## Proposed system contract

### 1. Keep source evidence and application history immutable

Procurement owns source documents and immutable **cost revisions**. A revision captures the exact source line IDs, source versions, currency basis, product/packaging/landed/adjustment components, authoritative extended amounts, explicit quantity denominator, and final/estimated evidence. Replacing a current allocation pointer must retain the previous revision. A mutable snapshot ID alone is insufficient.

Product quote/invoice authority is separate from packaging and freight authority. A receipt's copied price is not evidence of a manual override. An actual override requires its own explicit component, reason, actor, and version. The proposed ordinary priority is approved invoice evidence over quote estimates; treatment of a genuine authorized override remains an explicit policy decision.

### 2. Prove the full lot contribution graph

Inventory owns immutable contribution edges between source receipts, source lots, and output lots. New receipt lots capture receipt-line identity and frozen units. Transfers preserve the source edge and component state; conversions/builds record exact input/output quantities and component contributions. Existing build and canonical-operation evidence can supply proven edges; legacy missing evidence produces a review result.

Historical receipt/build snapshots remain historical. A later cost correction creates an application record and delta; it does not rewrite original physical consumption evidence. Transfers must not be counted as new purchases when calculating original cost coverage.

### 3. Apply each component through one inventory-owned command

Reuse the existing durable financial-command mechanism, extending it with exact source revision and expected application version. The command should:

1. Discover and bound the complete affected contribution graph, including sold descendants.
2. Validate source identity, quantity basis, currency, component contracts, and existing application versions before changing any lot.
3. Acquire a common, tested lock/version protocol shared with graph-creating physical owners; revalidate the graph after locking. A new descendant or changed source requires replanning, not silent omission.
4. Atomically record component updates, OMS COGS changes, immutable before/after evidence, actor/time, and the exact applied revision. A failed lot, COGS, or audit write rolls back that application scope.
5. Return durable applied/retry/review evidence. A replay of the same revision changes neither quantities nor economics. A source correction can reach already-finalized lots without selecting only `cost_provisional = 1`.

The current owner lock orders differ. This document deliberately does not claim that a single new `ORDER BY id` establishes a safe global protocol. The [shipment trace](procurement-cost-shipment-trace.md) records the concrete inversions and opposing-operation tests required before enabling this command.

### 4. Preserve exact totals and explicitly account for residuals

Use integer/decimal arithmetic and the recorded quote basis. Do not reconstruct an extended product amount from rounded cents or uniformly scale a rounded per-piece price and call it exact. Carry division residuals in the source/application contract and reconcile them across all affected quantities. Existing build allocation demonstrates remainder layers; changing costs on immutable existing lots requires an explicit residual/delta design too.

Signed credits stay signed in source history. The current allocation/COGS/build layer contracts reject negative values. A net negative component therefore needs a documented disposition and compatible consumers before application; silently clamping it to zero is not a valid credit policy.

### 5. Keep physical progress and financial progress distinct

Receiving can establish physical quantity while cost evidence remains provisional. A financial failure must be visible and retryable without requiring another receipt or double-posting stock. Shipment closure and inventory cost application should display separately. Product reconciliation must preserve freight-pending state; freight application must preserve the authorized product and packaging components.

The present receiving AP callback executes inside physical posting and can roll it back. Moving to a separately durable cost-application request is a proposed behavior change, requiring transaction/recovery tests and a clear user-visible status; it is not implemented by this audit.

## What is not proven / business inputs

- Which invoices include packaging in the product price, versus a separate charge. The schema has no reliable field that can establish this for every historical record. User input is pending.
- How short/damaged goods are normally recovered: vendor/carrier credit, absorbed cost, or case-by-case disposition. User input is pending. Until a disposition is recorded, the design should expose unresolved costs rather than silently redistribute them.
- Whether an estimate may be explicitly accepted as provisional cost, when absence of a charge means a confirmed zero, treatment of credits exceeding a component, and priority of a genuine manual override. These are policy inputs for financial automation, not facts inferred from arithmetic.
- Production affected records, affected monetary totals, active warehouse authority paths, migration 221 application, and live deployment behavior. No production financial or inventory data was read or repaired.
- An Archon cost export contract or carrier tracking integration. Neither was implemented or verified by this slice.

## Next checks and delivery order

1. Finish the policy-independent invoice metadata repair with real PostgreSQL preservation/rollback evidence. Keep characterization tests of known defects separate from regression tests that assert correct behavior.
2. Confirm invoice component semantics and exception dispositions; implement explicit source contracts and a read-only cost readiness projection in the existing purchase workspace.
3. Add immutable cost revisions and complete new-lot lineage through every applicable transfer/conversion/build owner. Prove component/quantity conservation and concurrent graph creation against cost application.
4. Implement and exercise the inventory-owned revision application command for both receive→invoice→freight and freight→receive→invoice, source corrections, failures, response loss, and sold/transformed descendants.
5. Preview historical review/correction scopes from actual evidence before any historical application. Preserve historical records and publish downstream deltas through a versioned export contract.

This sequence is a proposal for a coherent financial follow-up. The immediate invoice edit repair is independently useful, but neither that repair nor the cost-trace mockup is a claim that procurement costs now propagate correctly end to end.

## Final local validation for this worktree

- Typecheck passed with `npx tsc --noEmit --incremental false` after the final runtime edits.
- All 10 AP ledger unit suites passed: 89 tests. The additional focused invoice-import/edit run passed 42 tests (overlaps those suites; not an additive test count).
- The regular invoice metadata PostgreSQL suite passed 11/11, including strict numeric input, exact before/after audit, rollback and an actual invoice-approval lock race. It has a dedicated CI step.
- The separate opt-in cost audit reproduced its 9/9 expected baseline behaviors; its two rollback cases were rechecked after fixture cleanup changes. Those passing defect characterizations do not establish correct cost propagation.
- Independent review found and resolved the JSON numeric-coercion issue; the final scoped invoice update has no remaining review blocker.
- The cost-trace proposal was rendered in light/dark themes at 736px and 360px. All 12 state/width/theme combinations and component selections passed without horizontal overflow or script errors. This is a design preview, not deployed application UI.
- Whitespace checks passed. Local validation used synthetic data only; no production verification or production financial change was performed. The disposable PostgreSQL server was stopped after validation.
