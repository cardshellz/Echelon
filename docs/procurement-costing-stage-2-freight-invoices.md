# S2: approved freight invoice amounts reach shipment costs

Bounded COST-04 / COST-08 continuation in [PR #1983](https://github.com/cardshellz/Echelon/pull/1983), based on pinned deployed main `5407e8938999f8967aab2f4265849f8cab533a2d`. [Exact-head checks and current acceptance](https://github.com/cardshellz/Echelon/pull/1983/checks) are separate from deployment. No migration, production backfill or new expense destination is introduced. This is not completion of the whole costing plan.

## Exact execution and ownership

1. `APInvoiceDetail` mounts `FreightInvoiceCosts` for invoices with recorded freight source lines. It retains the review during parent query invalidation; cached document identity does not authorize a write. Product-only invoice approval retains its existing path.
2. `registerFreightInvoiceCostRoutes` validates canonical PostgreSQL identifiers and view/approval permissions. The application independently reads current persisted IAM authority; only an unscoped system Administrator with purchasing approval can preview or approve changes. Readers can see already-completed approvals without a new admin warning.
3. `readFreightInvoiceReviewSource` takes the existing global cost-graph lock, locks the invoice, complete lines, referenced charges and shipments, and reads full shared-shipment dependencies. `readInvoiceSourceCapabilities` proves source ownership, including competing retained sources. The version includes document money, source ownership, all affected stock/order cost dependencies and current authority.
4. Pure `planFreightInvoiceCosts` accepts explicit USD freight-only source lines whose quantity/unit/line/header amounts reconcile exactly. Every charge must belong to this invoice, supplier and shipment; every line must have a verified charge. BigInt calculations preserve exact cents and the existing AP unit-mill rounding rule. Unsupported evidence is a named review, never an inferred allocation.
5. `createFreightInvoiceCostService.preview` executes the real approval/cost owners inside a savepoint, collects measured changes, then rolls them back. No approval, document, allocation, inventory, order or history writes persist from preview. Generated audit/application identifiers and execution time do not set the reviewed economic version.
6. Approval uses `runTransactionalFinancialCommand`, scoped to current user, invoice, route and command. It rereads locked source/authority, verifies source version, executes again and verifies the measured impact version before committing.
7. `executeApInvoiceCommandInTransaction('approve_invoice')` owns AP's approval transition. Existing approval identity/time is preserved when already approved. Its clock is explicitly injected. Bill amount, paid amount and balance are invariant in this adapter.
8. `persistFreightInvoiceChargeAmounts` updates only the explicitly owned charge's actual cents and timestamp. The saved estimate, source references, shipping quantities and payments are preserved.
9. `ShipmentTrackingService.refreshQuantityAllocationInTransaction` owns allocation and finalization. On costing/closed shipments it reuses the source revision, cost application, remaining inventory, transfer/repacking and existing approved historical-destination owners. On an open shipment it updates shares and reports pending finalization; it does not claim inventory was updated.
10. Measured before/after covers charge actuals, retained estimates, invoice status/settlement, exact per-charge shipment/PO shares, on-hand value, order cost basis, existing approved historical postings and named unresolved issues. Charge shares must conserve every billed cent. Physical quantities are invariant. Order basis alone does not establish a sale or recognize an expense.
11. `recordFreightInvoiceCostApproval` stores immutable actor, current authority, reason, time, command key, complete measured preview and application evidence. PO events are recorded for every PO on the affected shared shipment. Invoice and PO history render the same saved preview.

## Concrete example

A two-PO shipment previously allocated a $15 freight charge as $5 / $10. Both receipts are closed. A later supplier invoice explicitly bills that same charge at $18.

- Creating the received invoice alone preserves the existing $15 cost and stock values.
- The admin preview shows $15 → $18, shares $5 → $6 and $10 → $12, and the actual remaining-stock/order cost changes. Invoice amount remains $18; payment is unchanged.
- One approval accepts the invoice and replaces the linked charge's actual amount with $18. Existing allocation and costing owners update the two receipts' cost destinations. The $15 estimate remains recorded.
- Receipt quantities and receive conversions, PO quantities, shipped pieces/cartons and payment records do not change.
- A repeated request returns the original approval receipt. A changed source or revoked authority rejects the stale review. No new expense is created to finish missing history.

Confirming freight does not confirm uninvoiced supplier product cost. A receipt with no approved supplier assignment remains provisional under the enabled receipt policy.

## Failure and recovery behavior

- Audit/posting failures roll back AP approval, charge actuals, allocations and downstream costs together. The existing financial command backoff and same-key retry remain in force.
- A committed response lost in transit retains the frozen request, preview and key across dialog close/reload. Unknown permission-gated outcomes retain that intent until the same command can be verified. A durable terminal rejection requires a fresh review and new key.
- Cross-user/invoice, changed-body and mismatched-result recovery records are refused. Browser-storage failure blocks sending an approval whose recovery cannot be retained.
- Costs already matching their approved invoice show the original approval and link to the existing shipment cost review for genuine remaining inventory work. No second identical approval is offered.
- Remaining missing physical evidence, provenance or inventory history is returned by the existing owner and displayed with a direct shipment cost-review path. It is not marked posted merely because AP accepted the bill.

## Deliberate limits

The adapter rejects mixed product/freight invoices, manual PO billing links, source credits, invalid/missing USD authority, unsupported statuses and unallocated header differences. Credit/header/FX adapters remain plan work. Subsequent invoice dispute/void/replacement continues through existing AP source-ownership controls; this bounded acceptance command does not add a new automatic freight reversal. The broader S2 command inventory and withdrawal/replacement integration remain open. It does not infer invoice-to-receipt product mappings, classify historical stock as sold, or change external accounting recognition semantics. No production document or cost was changed by implementation or verification.

The preexisting `apInvoiceCommands.approveInvoice` / `executeApInvoiceCommandInTransaction` entry point remains backward compatible as an AP document approval. Calling it directly does not implicitly accept a different bill amount into the shipment charge. The freight invoice UI now uses the reviewed reconciliation command for that combined action; an already-approved bill with a different charge amount still requires this cost review. Broader command/read-model convergence must not mistake AP approval alone for acceptance of the freight variance.

## Validation record

Current local results:

- 164 tests / seven files: new domain and persistent approval intent, affected routes/AP compatibility, writer and typecheck guards.
- 313 tests / 19 files: AP approval/editing/payment/physical-status behavior, receipt costing, source ownership, cost status/impact, financial commands and migration-prefix regression. These counts overlap the focused run.
- 14 mocked desktop/mobile browser cases: before/after, original completed approval, current authority, committed-response loss/reload/same-key recovery, recorded rejection/new review, unknown permission outcome and exact PO-line/return navigation.
- Four connected desktop/mobile journeys: UI receiving for two POs, real shipment finalization, late freight invoice creation, measured rollback-only review, one actual approval, correct stock/PO shares and immutable PO history; plus differently priced supplier invoices assigned to two separate receipts without changing their quantities or bills. The connected server uses actual HTTP/DB owners, not API mocks.
- 18 targeted real HTTP/SQL cases passed (328 unrelated cases excluded by the explicit filter): complete-source/identifier checks, no-write preview, actual inventory/order-basis effects, same-key replay, original AP approval retention, stale input, current persisted authority, revoked permission, audit rollback/backoff/retry, concurrent commands, multi-PO shares, open-shipment pending state and uninvoiced provisional inventory.
- Application, server-test, client-test and connected-test TypeScript projects passed with an 8 GB compiler heap. Production build passed.
- Hosted client-test typechecking then exhausted Node's default heap at 2,017 MB. A complete local rerun with a 6 GB heap and extended diagnostics passed, reporting 3,445,442K used across 3,052 files. The isolated CI client lane now has explicit 6 GB headroom and reports diagnostics; file scope, exclusions and compiler strictness are unchanged. Final hosted acceptance is tracked on the PR.
- The complete 346-case receipt/AP/freight/tax regression is a separate acceptance gate; its latest result and hosted exact-head checks are recorded in the PR. It is not counted as additional disjoint coverage here. The first full run passed 345 cases and found one test-fixture permission omission in the new reader assertion; the fixture now explicitly grants viewing and removes approval for that reader. All 18 affected public-route cases then passed without weakening middleware or administrator policy.

The new SQL cases use actual public routes, persisted IAM/AP owners and the existing disposable PostgreSQL fixture; mocked UI tests complement rather than replace those assertions. Connected fixture changes are restricted to fresh synthetic databases and fail if receipts, applications or payments already exist. The extracted receiving UI helper retains the prior receipt scenario and waits for loaded shipment actions before checking whether delivery is needed.

Candidate failures were resolved without weakening financial checks: parent invoice invalidation originally unmounted the review (runtime fix retains it); the extracted test helper originally checked optional delivery before page load (deterministic wait); history and Close test locators were ambiguous (specific locators). The durable owner's retry backoff remains enforced and is followed by the SQL failure/retry test. Mobile and desktop review screenshots were inspected.

Reproduce the SQL acceptance with `ECHELON_TEST_DATABASE_URL` pointing only to an explicitly disposable local PostgreSQL database, `ECHELON_TEST_DATABASE_DISPOSABLE=true`, and `TZ=UTC`:

```text
node node_modules/vitest/vitest.mjs run server/modules/procurement/__tests__/integration/receiving-cost-application.integration.test.ts --no-file-parallelism --allowOnly=false
```

Connected acceptance uses `playwright.procurement-connected.config.ts` with `freight-invoice-cost-workflow.spec.ts` and `receipt-invoice-cost-workflow.spec.ts`. Each case creates its own guarded disposable database and actual app process, then removes only its owned fixture. The mocked suite uses `playwright.procurement.config.ts` with `procurement-freight-invoice-costs.spec.ts`.
