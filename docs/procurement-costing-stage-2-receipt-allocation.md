# Receipt-specific supplier invoice costing

Status: implementation in progress on PR #1979; no production activation or acceptance claimed.

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

`refreshReceiptProvisional` evaluates each original receipt independently, then follows real transfer/repacking inputs. It clears an inventory provisional flag only when supplier coverage and that receipt's separate landed charge are confirmed and applied. Procurement persists the before/after audit in the same transaction. PO totals and each split shipment's supplier rate use the same source intervals; an unreceived shipment never borrows another receipt's invoice price. Rounded display rates are not financial inputs.

`supplierCostReviewTasks` exposes either the exact receipt-assignment action or the remaining invoice work. Invoice detail, shared PO/shipment cost review and receiving open the same editor. Immutable approval details, including their original before/after, are available in the editor and PO History. A later invoice approval delegates to the same source/application owner, without rewriting the provisional quote or changing an earlier mapping.

## Candidate validation

- Initial domain tests: 21 passed; expanded interval, shared-status, own-shipment-rate and exact PO projection tests are included in the current suite.
- Public HTTP/real SQL acceptance: 18 passed after adding real transfer and package-conversion propagation. It covers partial and later receipts, source/stock/permission changes, durable duplicate retries, concurrent approvals and audit rollback. The later real AP approval and policy-edit rejection cases are running with the final candidate.
- Full existing receipt/AP/freight suite previously passed 322 tests; a final expanded repeat is pending. These are owned disposable SQL fixtures, not production data.
- Desktop/mobile mocked browser: all 18 passed, including lost-response/reopened approval recovery, definite permission rejection and saved approval details. Visual review found cramped mobile amount spacing; explicit column spacing is now included.
- Production, server-test and client-test TypeScript projects passed; the production build passed. Final changes are being checked again before review.
- The actual migration's four PostgreSQL cases passed, including adjacent intervals and both overlap exclusions. The new suite is registered in the shard inventory and its independent coverage guard.
- The ownership baseline adds only `procurement.receipt_invoice_cost_allocations -> modules/procurement`; existing public audit ownership is retained. Latest main `b80898c9b` is incorporated; its changes concern customer-account live-theme configuration.

Remaining gates: final affected SQL/types/connected browser runs, final-head hosted CI and a ready-for-review PR. One concurrent local browser run completed its assertions but failed database cleanup; isolated acceptance must confirm cleanup before claiming success. No live financial or inventory record has been changed. Merge, deployment and production acceptance remain separate gates.
