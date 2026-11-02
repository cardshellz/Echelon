# Stage 2: one approval for an invoice correction and its cost effects

Date: 2026-11-01. Continues the [active cleanup plan](procurement-costing-cleanup-plan.md), COST-03 and the correction portion of COST-08. This is a bounded integration of existing financial owners, not completion of all Stage 2 adapters or a production data repair.

## Confirmed rule and activation boundary

The user confirmed: **keep each receipt's invoice cost** when batches have different invoice prices. Do not average those prices across a PO line. The explicit invoice-to-receipt allocation adapter is still required. This candidate rejects a new confirmed whole-line correction with multiple approved invoice rows before the legacy aggregator could average their costs. If that legacy source is already unconfirmed, the document can be corrected with a durable unresolved cost result; it cannot post guessed receipt costs.

Supplier-tax treatment is unanswered. This candidate adds no tax inclusion default. Partial coverage, combined amounts without a known split, adjustments, freight reconciliation and ordinary AP approval binding remain tracked work.

## Concrete execution trace

1. `registerInvoiceQuantityCorrectionRoutes` in `server/modules/procurement/invoice-quantity-correction.routes.ts` checks current purchasing view/approve permission, validates the URL identifier and binds the financial command to its actor, route and invoice line.
2. `readInvoiceQuantitySource` / `readInvoiceBillingSource` in `invoice-quantity-correction.repository.ts` discover the PO, acquire the existing graph/PO/invoice/identity locks and capture all invoice lines, payment allocations, PO allocations, credit history and freight links. The version includes the reviewed behavior version as well as source facts. Direct freight-charge links are checked even when no freight invoice line exists.
3. `planInvoiceQuantityCorrection` in `invoice-quantity-correction.policy.ts` validates the proposed quantity, unit price, amount and optional supplier breakdown. Exact component mills must equal the complete line cents times 100. Known components remain on a quantity-only edit. A changed amount or unit price without new components clears the old split instead of treating it as current evidence. Explicit zero is distinct from unknown.
4. `createInvoiceQuantityCorrectionService` checks current administrator authority and the existing purchase approval policy. Preview runs its common `execute` path inside a rolled-back savepoint. Approval runs the same path inside `runTransactionalFinancialCommand`.
5. `execute` reads the complete dependencies and exact remaining stock values, calls `persistInvoiceQuantityCorrection` to save the document and refresh AP totals/matching, then calls `applyInvoiceCorrectionCosts`. It does not replay receipt, shipment or cash operations.
6. `applyInvoiceCorrectionCosts` calls **the existing** `reconcilePurchaseCostEvidence` -> source revision -> cost application -> `COGSService` chain. `readPurchaseCostStatus` supplies current completion; old application flags are not a separate status owner. Shared `supplierCostReviewTasks` supplies remaining work.
7. `readInvoiceCorrectionInventoryValues` uses `lotCostTotals` and `readUnallocatedLotCosts`, the existing exact valuation owners. It does not multiply rounded unit rates. An unproved legacy value is displayed as unverified. Limits/infrastructure failures abort; a known stock-history exception can coexist with a saved bill and recorded cost-review outcome.
8. The resulting preview includes supplier sources, exact original-lot and remaining-stock values, order cost basis, approved historical postings, supplier-return values and application outcomes. Generated source/application identifiers are excluded from approval identity; full actual application receipts are retained in audit.
9. Every new approval must supply the measured `previewVersion`. The transaction recomputes the effects and rejects a different version before commit. Only then does `recordInvoiceQuantityCorrectionResult` append the actor, reason, authority, before/after, source version, impact version and actual cost receipts to audit and PO history.
10. An existing committed old-format financial command receipt replays before new work. It cannot acquire new costing authority because the deployment added costing to this command. An uncommitted old request must obtain a new preview.

`readInvoiceCorrectionCostDependencies` retains the common reader's complete shared-shipment locks while limiting the displayed supplier effects to the edited PO line's cost graph. It does not claim unrelated POs' inventory changed.

## Before and after examples proved by local SQL tests

| Scenario | Before | After one approval | Preserved facts |
| --- | --- | --- | --- |
| Wrong invoice count; complete saved supplier components | 50 invoiced / 100 received; remaining inventory $110 | 100 invoiced; remaining inventory $130 from $120 product + $10 packaging | Stock count, receipt, shipment and cash |
| Correct a paid bill on a closed PO | Invoice $130, paid $130, balance $0, stock $110 | Invoice $150, paid $130, balance $20, stock $150 | PO remains closed; no new payment |
| One of two received units already picked for an order | Remaining inventory $55; order basis $55 | Remaining inventory $65; order basis $65 | Physical quantities; no historical expense invented |
| Exact residual cents/mills | Two received units, one picked | Total 200 mills: remaining stock 101, order basis 99 | The 101-mill rounded unit mirror is never multiplied into a false 202-mill total |
| Changed bill without a new product/packaging split | Previously reviewed split | Document saved; old split cleared; durable supplier review remains | Unknown components are not zero; inventory is not repriced from a guessed split |
| Missing original receipt cost evidence | Bill can be corrected | Document saved; actual cost application reports the receipt-history task | No invented sale, expense or stock movement |

Order rows represent **order cost basis**, including picked/unshipped orders. They do not prove sale recognition. The external accounting recognition boundary documented in Stage 1 remains unverified. This candidate does not change that reporting/recognition contract or select a historical expense destination.

## Explicit unsupported scopes

- Multiple confirmed invoice rows requiring receipt-specific assignment: reject rather than average. A receipt allocation workflow is the next source-adapter task.
- Mixed product/freight bills or direct freight-charge links: the current `resolveShipmentBillingOwnership` contract treats mixed product authority as incompatible with the shipment billing owner. Shipment source evidence also includes the full bill's totals/lines. A product-only save could therefore leave freight status stale. The context and plan now explicitly reject this scope pending the combined invoice/charge owner. No charge, allocation or original freight approval is rewritten.
- Multi-PO billed-amount changes, partial PO monetary allocations, credit history, currency mismatch, overpayments, cancelled/returned/short-closed lines: existing owning-workflow guards remain in force.
- Unknown cost lineage: actual cost results remain visible and actionable through the existing shared review. Saving an invoice does not manufacture missing history.

These restrictions are disclosed limitations, not acceptance of the broader COST-02/04/07 tasks.

## Command-owner inventory and remaining work

The following entry points were read during this slice. This inventory identifies the relevant owners; full mutation-scope acceptance remains a separate Stage 2 gate.

| Financial change | Public/application path | Existing cost owner / remaining gap |
| --- | --- | --- |
| Invoice quantity, price, amount or components corrected together | `registerInvoiceQuantityCorrectionRoutes` -> `createInvoiceQuantityCorrectionService` | This candidate binds document and measured supplier-cost effects to one admin approval/transaction |
| Ordinary invoice approve/dispute/void | `createApInvoiceCommands` -> `executeApInvoiceCommandInTransaction` -> `approveInvoiceInTransaction` / `disputeInvoiceInTransaction` / `voidInvoiceInTransaction` | `reconcileApprovedInvoiceVariance` -> `reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction` -> `reconcilePurchaseCostEvidence`; full reviewed-impact binding remains open |
| Supplier breakdown reviewed separately | `createInvoiceCostReviewCommands` -> `reviewInvoiceCostComponentsInTransaction` | [Current continuation](procurement-costing-stage-2-supplier-approval.md) requires measured impact/current persisted Administrator for new approvals and retains linked immutable history. Receipt assignment adapter deployed in #1979; live posting acceptance remains unproven |
| Approved PO amendment | PO amendment owner -> `refreshPoAmendmentCosts` | Supplier reconciliation plus `refreshQuantityAllocationInTransaction` for affected shared shipments; remains the commercial-edit owner |
| Shipment costs or measurements changed | `createShipmentCostUpdateCommands` -> `updateCostsInTransaction` | Allocation/finalization -> `applyShipmentCostRevisions`; measurement corrections reuse that owner and existing historical approvals |
| Receipt/shipment quantity correction | `createReceiptShipmentQuantityCorrectionService` | Existing quantity correction transaction calls supplier reconciliation and shipment owner; not replayed by an invoice correction |
| Receipt processing / recovery | `enqueueReceiptCostRequests` / `processReceiptCostRequests` | Existing durable receipt request/recovery owner; later stock application must follow approved source rather than issue a new approval for unchanged money |
| Source-backed supplier credit | `createSupplierCreditCommands`; `supplier-credit-source.service.ts` | Existing supplier reconciliation and shipment revision owners; header/source allocation and receipt-specific coverage still need broader acceptance |
| Freight invoice amount differs from its charge | `createFreightInvoiceCostService` -> existing AP / allocation / finalization owners | Bounded freight-only USD review deployed in #1983; [verified release and remaining limits](procurement-costing-deployment-1983.md). Mixed/header/credit scopes still require coordinated work |

## Local validation

The public HTTP cases live in `server/modules/procurement/__tests__/integration/invoice-correction-costs.cases.ts`, registered in `receiving-cost-application.integration.test.ts`. They use real PostgreSQL, IAM/permissions, AP payments, command receipts, receiving, source/application/valuation/status/reporting and audit owners. Only fixture session injection and deliberately synthetic source records are test setup; no cost-writer/query-result mock establishes the assertions.

Coverage includes preview rollback, exact stock/order values, a paid closed bill, unknown components, missing origin, explicit zero, exact residuals, stale/absent impact versions, changed inventory, revoked admin authority, concurrent distinct approvals, lost response retries, legacy committed receipt replay, mixed bill guards, no receipt-price averaging and injected reporting/audit failures with rollback and retry.

The existing PO correction fixture now obtains a real measured invoice preview before a new approval; it does not relax authorization or state assertions. Desktop/mobile browser tests additionally verify the optional same-modal supplier amounts, immutable confirmation/recovery, blocked incomplete previews, visible posted result and approval record. Their APIs are mocked; SQL tests supply financial persistence evidence.

Tests run only against a newly owned PostgreSQL 17 cluster bound to `127.0.0.1:55441` under ignored `.codex-artifacts/stage2-invoice-correction-pg`, with two disposable databases. No production or existing database is used. The [tracker](procurement-costing-cleanup-plan.md) records final counts, exact review head, hosted checks and release/live acceptance separately.

Targeted SQL command:

```powershell
$env:ECHELON_TEST_DATABASE_URL = 'postgresql://test@127.0.0.1:55441/echelon_invoice_correction_test'
$env:ECHELON_TEST_DATABASE_DISPOSABLE = 'true'
node node_modules/vitest/vitest.mjs run server/modules/procurement/__tests__/integration/receiving-cost-application.integration.test.ts -t 'invoice correction through HTTP and real cost owners' --reporter=dot
node node_modules/@playwright/test/cli.js test --config=playwright.procurement.config.ts test/browser/procurement-invoice-quantity-correction.spec.ts --reporter=line
```

Run the SQL file without `-t` for all receipt/AP/freight cases. Use the separate `echelon_invoice_correction_compat_test` database for `po-quantity-amendment.integration.test.ts`; never run independently resetting fixtures concurrently against the same database.
