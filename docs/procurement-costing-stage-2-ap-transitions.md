# Reviewed AP invoice authority transitions

## Proven baseline and defect

Baseline is `6a43c7b656004d93b6fb182b6f10ba93f394ce77`, independently verified in release v3453. `ap-ledger.routes.ts` exposes ordinary invoice approve/dispute/void through `createApInvoiceCommands`. That command already used the durable financial-command transaction and `executeApInvoiceCommandInTransaction`. AP then calls `reconcileApprovedInvoiceVariance` and the existing `reconcilePurchaseCostEvidence` owner. The defect is missing binding to a reviewed financial impact, not a missing second posting system.

`approveInvoiceInTransaction` also overwrote `approved_at` / `approved_by` when releasing a dispute. Reapproving a partially settled disputed bill assigned status `approved` rather than deriving its payment status. Both issues are corrected without changing the bill, payment evidence or original approval.

## Owning execution path

1. `registerInvoiceTransitionPreviewRoutes` exposes action-specific previews. Existing permissions are preserved: approve/void require `purchasing:approve`; dispute requires `purchasing:edit`. Canonical positive PostgreSQL integer IDs and strict reason/version inputs are validated. Initial AP approval does **not** acquire an invented Administrator requirement. Existing administrative correction flows retain their own stronger policy.
2. `createInvoiceTransitionPreview` invokes `reviewInvoiceTransitionInTransaction` in a savepoint and rolls back every AP, cost and audit write. It executes the real owners, not a parallel estimate. Preview does not retain a new approval or run post-commit detection.
3. The transactional adapter takes the shared cost-graph lock, locks the invoice/lines/PO links, reads complete dependencies (including other POs sharing shipments), and obtains current persisted action-specific IAM grants under share locks. Inactive/revoked/scoped-only grants cannot authorize a global action. Session role labels are insufficient.
4. `executeApInvoiceCommandInTransaction` remains the AP owner. It preserves its invalid-state, payment and credit-history guards. Approval selects the invoice as eligible cost evidence; dispute/void withdraw that authority. Receipt assignments remain explicit and uncovered quantities provisional. Ordinary freight AP approval remains document-only; accepting a changed shipment charge still belongs to the existing reviewed freight command.
5. The existing supplier updater selects and applies source revisions. `readInvoiceCorrectionInventoryValues` and `buildCostDestinationImpact` read actual before/after stock value, order cost basis and already-approved historical destinations. Unknown values remain unknown with reasons. An order cost basis is not asserted to prove a sale. No expense destination is inferred.
6. A new public action must supply its measured preview version. It binds the original invoice/line/link evidence, complete prior dependencies, current actor/grants, intended action/reason, selected source contracts, actual effects and remaining reviews. Changed evidence rolls back the real command. Generated IDs and execution clock are retained in evidence but excluded from the economic fingerprint.
7. The existing durable financial-command owner remains responsible for safe retry and concurrency. Already committed predeployment receipts replay before new validation. New commands cannot bypass review. A single command transaction retains the reviewed result in the new immutable `ap_invoice_transition_reviews` ledger, operational audit and linked PO events. Missing retention rolls the command back. The ledger also covers invoices without PO links.
8. `InvoiceTransitionReview` supplies one compact desktop/mobile before/after experience for all three actions. Ambiguous responses freeze the same request/key for safe retry. `InvoiceTransitionHistory` reads the retained actor, reason, time and exact reviewed effects; it does not reconstruct them from current prices. Parent invoice and shared purchasing queries refresh after success or failure.

## Monetary and physical boundaries

Invoice amount/lines, payments, receiving configuration, actual stock/received/shipped/invoiced counts and shipment charges are preserved. Approval release retains the original approval while using the existing exact `deriveInvoiceFinancialState` projection for settlement status. New actions do not add cash, recognize an unverified sale, guess a supplier split, infer receipt coverage or introduce an FX policy. Missing source/history support remains a visible cost review, not a hidden success or forced repair.

`900000051000000000001_ap_invoice_transition_reviews.sql` adds only the retained approval ledger, its invoice/actor relationships, command identity uniqueness, and update/delete/truncate guards. There is no historical monetary backfill. Old clients attempting a **new** action without a preview receive a classified review-required response; old committed command results remain replayable.

## Acceptance and remaining work

Real SQL/HTTP cases are registered from `ap-invoice-transition.cases.ts` in `receiving-cost-application.integration.test.ts`. Connected acceptance is `ap-invoice-transition-workflow.spec.ts`, using actual receiving, AP, source/application, valuation, IAM and history owners for a two-PO bill. UI recovery cases additionally exercise lost responses and stale reviews. Exact candidate results and hosted checks are recorded in the tracker after validation.

This is gate A2. Combined unknown-split supplier amounts/header adjustments, complete receipt-specific credit/tax attribution, downstream accounting recognition, consumer convergence and actual production posting acceptance remain the A3/A4/B1/C1/D1/D2 gates. This stage does not claim the entire cleanup is finished.
