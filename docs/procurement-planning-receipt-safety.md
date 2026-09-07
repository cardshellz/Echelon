# Receipt-safe procurement planning

## Confirmed source behavior

`ReceivingService.close` in `server/modules/procurement/receiving.service.ts` commits physical stock and the closed receiving order before calling `reconcileLinkedPurchaseOrder`. That orchestration calls `PurchasingService.onReceivingOrderClosed` in a separate transaction. An interruption or failed PO reconciliation can therefore leave usable warehouse stock present while the PO's received counter remains unchanged. The old `getReorderAnalysisData` query credited that same quantity as both warehouse stock and open PO supply.

`procurementMethods.getReorderAnalysisData` now calls `readPurchasePlanningSnapshot` (`purchase-planning-snapshot.repository.ts`). Its settings, warehouse/forecast query, and `readPurchasePlanningSupply` execute in one read-only PostgreSQL repeatable-read transaction. A physical close committed between those reads cannot mix the before and after positions.

`readPurchasePlanningSupply` (`purchase-planning-receipt-supply.repository.ts`) loads active committed product PO lines, closed receiving lines, exact shipment identities, original PO receipt postings and reversal evidence. `projectPurchasePlanningSupply` replaces the PO mirror with the verified net physical receipt quantity when computing remaining inbound pieces. It does not subtract the mirror and physical receipt twice. Fully physically received quantities disappear from inbound even if PO synchronization is pending.

`resolvePurchaseReceiptQuantities` (`purchase-receipt-quantity-evidence.ts`) is shared with the pipeline through the existing `resolvePipelineReceiptQuantities` export. It uses `resolveReceivingUnitSnapshot`: frozen receive units, or a unique matching original closed-receipt posting when historical frozen units are absent. Reversals must match the exact receiving line/order and captured base-unit quantity. Current catalog pack sizes never reinterpret receipt history.

The PO mirror must equal the verified net quantity of **posted** receipts. Newly closed but unposted physical receipts contribute physical quantity independently; they cannot explain an older mirrored receipt count. This is supported by the actual receipt owner posting/mirror transaction and `ReceiptReversalService`'s atomic physical reversal/PO counter update. An inconsistent mirror is review evidence, including a historical reversal whose counter does not reconcile.

## Visible uncertainty and retry behavior

Missing frozen units, unlinked receipt sources, incomplete original/reversal evidence, inconsistent mirrors or overcoverage produce per-PO-line review issues. The old remaining PO commitment is retained only as an unresolved fallback to avoid inventing another purchase. `buildPurchaseSupplyTiming` reports `unverified_receipts`, withholds trusted arrival coverage and captures the source quantities and receipt identities. `generatePurchasingRecommendations` emits an `inbound_supply` automation block even if the calculated purchase quantity is zero.

The default Reorder Engine queue includes supply-review rows. Receipt uncertainty replaces the affected product's Healthy/On order assurance with **Receipt review**, labels fallback supply **Unresolved PO commitment**, and links the recorded issues to the PO workspace. The drawer explicitly withholds a verified buy/no-buy conclusion. The legacy purchasing view and the automation review queue also expose the reason. These are review controls; no inventory, receipt, PO or historical snapshot is rewritten by reading the analysis.

New recommendation runs identify the calculation as `purchasing-recommendation-v3-receipt-supply`. Source-run and RFQ idempotency keys are unchanged. `planAutomaticRfqDrafts` requires a valid matching receipt-aware capture before new unattended RFQ creation; `createAutomaticRfqDraftService` checks the locked durable capture again. Old captures remain readable, and an exact existing RFQ can still be returned on retry. Missing capture cannot create a replacement RFQ or a new same-day key. No vendor sending is added or activated.

## Arrival precedence

`resolvePurchaseOrderArrival` is used by both planning and pipeline projections. It selects the line's supplier promise, then the explicit line date override, then the vendor-confirmed PO date, then the original requested PO date. This preserves the schema's line override while preventing an earlier header request from overriding a later vendor confirmation. Missing dates remain unknown. Dates remain estimates rather than proof of receipt or pickable stock.

## Verification and boundaries

The focused domain suite covers pending and synced partial receipts, split receipts, fully received lines, frozen/legacy factors, exact original postings, reversals, posted-vs-unposted mirror ambiguity, overcoverage, corrupt identities, no input mutation, explicit date precedence, late-arrival stockout gaps, and zero-buy review eligibility. Automatic RFQ tests cover verified empty versus absent capture, revalidation of locked evidence, rejection without writes and exact historical replay. Existing engine, route, snapshot, job, pipeline and client helper tests are included in the focused run.

`purchase-planning-receipt-supply.integration.test.ts` uses the actual warehouse query and planning snapshot/supply readers against an isolated disposable PostgreSQL database. Its second connection commits a physical close between reads to prove the snapshot boundary; it also verifies read-only enforcement. The CI workflow runs this database suite explicitly. `test/browser/procurement-planning.spec.ts` proves default-queue visibility, issue/PO links, unresolved labels and wrapped explanations on desktop and mobile, including zero-buy `ok` and `on_order` cases.

Historical receipt facts that cannot be proven still require operator review; this change does not invent or backfill them. Evidence queries fail visibly if required storage is absent or their named 10,000-row safety limit is exceeded. No production activation, carrier integration, live stock mutation, catalog-unit migration or automatic purchase was performed as part of this correction.
