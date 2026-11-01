# Receipt-specific supplier invoice costing

Status: locally verified implementation on PR #1979; hosted CI and review remain required. No production activation or acceptance claimed.

Confirmed policy: each receipt keeps its own invoice cost. Uncovered pieces keep the provisional PO source. Explicit admin approval binds the exact before/after; receiving, shipments, stock counts, supplier bills and payments retain their owning facts.

## Concrete trace and change

- `readPurchaseCostSources` / `resolvePurchaseCostSource` previously produced one product and packaging amount per PO line. `applyCostRevision` projected every frozen origin from that global amount/denominator. Partial invoices could not establish individual receipt costs.
- `receipt_invoice_cost_allocations` records explicit receipt/invoice piece intervals. `receipt_costing_enabled` opts a PO line into the policy; no historical allocation is inferred or backfilled.
- `readReceiptCostingEvidence` validates frozen effective origin intervals and saved receive conversion. Reversed or inconsistent histories remain blocked with a named resolution.
- `resolveReceiptInvoiceSources` reuses the existing invoice/component/tax resolver for each selected invoice. It retains exact original invoice offsets and fills uncovered purchase intervals from the PO estimate.
- `receiptSegmentCost` uses the existing exact integer interval allocator. `applyCostRevision` prices each root from its receipt's intervals, then uses the existing transfer/repacking/order-cost propagation and historical reconciliation owners.
- `createReceiptInvoiceCostService` uses graph/document/current-IAM locks, the durable financial command owner, rollback-only real previews, source/impact versions, immutable audit and PO events. It does not change a physical quantity or select an expense destination.
- `ReceiptInvoiceCosts` provides shared invoice/PO-cost/receiving entry points. Saved intents retain their key through uncertain outcomes; definitive recorded rejections require a new review.

## Activation and operational limits

Normal PO entry, bulk entry, recommendation handoff and approved added lines enable receipt-specific selection. Input schemas exclude that internal policy; ordinary PO edits cannot disable it. Historical lines retain their recorded sources until an administrator reviews their explicit assignments. The migration changes no historical cost or approval.

Only completed receipts with a proved saved piece conversion and complete cost-origin intervals can receive invoice assignments. The editor supports partial invoices, partial receipts and explicit interval overrides. Invoices without supported product/packaging/tax/currency evidence must be corrected through their existing invoice review first. Receipt-specific credits, unsupported FX, changed or reversed receipt history and unallocated header charges retain a visible owning review; this slice does not guess their attribution.

A complete supplier-credit return before acceptance has no inventory batch to assign. With no accepted receipt destinations or mappings, the existing supplier-credit source may retain its verified zero-inventory disposition; its original live custody/reporting checks still decide application. This is not a receipt-credit allocation adapter. Any accepted receipt destination or incomplete/contradictory credit keeps review. The existing real SQL return case now proves this with the new policy enabled, including reporting rollback, current status/history, concurrent retries, preserved bills/stock and no COGS or inventory posting.

`refreshReceiptProvisional` evaluates each original receipt independently, then follows real transfer/repacking inputs. It clears an inventory provisional flag only when supplier coverage and that receipt's separate landed charge are confirmed and applied. Procurement persists the before/after audit in the same transaction. PO totals and each split shipment's supplier rate use the same source intervals; an unreceived shipment never borrows another receipt's invoice price. Rounded display rates are not financial inputs.

`supplierCostReviewTasks` exposes either the exact receipt-assignment action or the remaining invoice work. Invoice detail, shared PO/shipment cost review and receiving open the same editor. Immutable approval details, including their original before/after, are available in the editor and PO History. A later invoice approval delegates to the same source/application owner, without rewriting the provisional quote or changing an earlier mapping.

## Candidate validation

- Purchasing/inventory regression and ownership guards: 6,430 tests passed across 399 files. The expanded domain suite covers shared-status round trips, own-shipment rates, exact PO totals and invalid interval identities.
- Public HTTP/real SQL acceptance: 21 receipt-specific cases passed, including real transfer/package-conversion propagation, real later AP approval without repricing the earlier receipt, ordinary PO-edit policy rejection, partial/later receipts, source/stock/permission changes, durable retries, concurrency and audit rollback.
  A later real invoice-void case raises this targeted scope to 22: the initially reproduced stale confirmed flag now becomes provisional while posted amounts and original approvals are preserved. Admin removal of the invalid mapping restores the valid receipt's confirmed state and leaves the uncovered receipt provisional. The same graph/document transaction and cost owner perform that resolution.
- Full receipt/AP/freight suite: 325 tests passed. The additional two policy-edit cases passed in the 21-case targeted run; these scopes overlap and are not added together. These are owned disposable SQL fixtures, not production data.
- PO entry HTTP/SQL recovery: 22 passed in CI's UTC timezone. Inline creation and adding a new draft line enable the policy; editing an existing historical line preserves its original policy.
- Desktop/mobile mocked browser: all 18 passed, including lost-response/reopened approval recovery, definite permission rejection and saved approval details. Visual review found cramped mobile amount spacing; explicit column spacing is now included.
- Production, server-test and client-test TypeScript projects passed; the production build passed. The final shared action refinement also passed 244 purchasing UI/domain and money-boundary tests; final-head hosted compilation remains part of CI.
- The actual migration's four PostgreSQL cases passed, including adjacent intervals and both overlap exclusions. The new suite is registered in the shard inventory and its independent coverage guard.
- The ownership baseline adds only `procurement.receipt_invoice_cost_allocations -> modules/procurement`; existing public audit ownership is retained. Latest main `b80898c9b` is incorporated; its changes concern customer-account live-theme configuration.
- Hosted preflight identified two unchecked native conversions. They now use the existing exact readers; the money-boundary/domain repeat passed 27 tests without new exemptions.
- Rebuilt connected browser acceptance passed all four desktop/mobile receipt and tax cases, including clean database teardown. The receipt case receives two batches through the real UI, previews different invoice prices without writes, approves once, checks unchanged counts/bills and reads the original approval from PO History. Unreceived invoice pieces lead to receiving; returns with no accepted inventory do not offer a receipt-cost assignment. Missing return proof remains in review.
- Hosted CI on runtime commit `16e59effa` passed all 56 connected procurement cases, all three TypeScript projects and the money/architecture guards. Its controlled RFQ fixture lacked the new allocation table; adding that schema declaration made all four RFQ/receipt/sale/late-freight/settlement cases pass locally with the original $4,610 conservation and exact-once assertions unchanged. Final-head CI must verify the fixture update; no runtime check or assertion was relaxed.

An earlier local browser run completed its assertions but failed cleanup while PostgreSQL was performing a 66-second checkpoint (recorded in the owned cluster log). After a normal checkpoint, the complete four-case repeat passed without changing cleanup checks or durability settings. No connected test databases or application connections remained. The owned test cluster stopped cleanly at 16:41:31 local on 2026-11-01.

Hosted returns acceptance exposed an unrelated row-order assumption in its tracking queue test. `claim` prioritizes the selected jobs but its `UPDATE ... RETURNING` does not sort them. The assertion now requires exactly the two current job identities, preserving the backlog-starvation check without changing shipping behavior. All 46 cases in the actual SQL returns file passed locally; its browser aggregate had reported the same dependency failure. Final-head hosted CI remains required.

Remaining gates: final-head hosted CI, review, merge, deployment and production acceptance. No live financial or inventory record has been changed. This slice does not close the plan's remaining combined/credit/header-source or external recognition work.
