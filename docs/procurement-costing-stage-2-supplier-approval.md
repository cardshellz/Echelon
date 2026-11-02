# Supplier cost approval binding

## Confirmed gap and execution trace

On baseline `56c547ae5f8e0ff60e7d0570999a58f3b973ef92`, `createInvoiceCostReviewCommands.review` called `reviewInvoiceCostComponentsInTransaction` with a request whose `previewVersion` was optional. That function only captured/compared the financial impact when the caller supplied it. The public route checked purchasing approval permission, but this command did not read the current persisted Administrator role. The UI already requested a preview; a direct API call could skip it. This conclusion comes from the executable command path, not from the UI's disabled state.

The revised path is:

1. `registerInvoiceCostReviewRoute` validates the canonical invoice-line identifier, authenticated actor, purchasing approval permission and existing financial-command transport. Unexpected failures return a safe retry message and a structured error classification without SQL details.
2. `createInvoiceCostReviewCommands.review` reserves the existing durable financial command. A committed legacy receipt replays before new validation, with no new source, posting or approval. Uncommitted commands must satisfy the new rules.
3. `reviewInvoiceCostComponentsInTransaction` requires `previewVersion` for a new standalone approval. It takes the existing cost-graph lock, locks invoice/line and complete dependencies, then reads persisted identity/role/grant evidence through `readPurchaseApprovalActor`. A session's `admin` label, a custom role with the same name, a scoped-only grant, an inactive user or a Team Lead grant cannot authorize the write.
4. `persistInvoiceCostComponents` writes explicit supplier components only after their exact integer-mill sum reconciles to the unchanged invoice line. `reconcilePurchaseCostEvidence` remains the sole supplier-cost owner; this change introduces no posting or COGS engine.
5. The real owner runs in a rolled-back preview and again inside approval. The version binds invoice economic authority/currency, selected sources, complete prior dependencies, persisted approving authority, actual stock/order/historical effects and application issues. Newly generated IDs are excluded. Approved/partially-paid/paid remain the same costing authority; settlement progression alone does not invalidate review.
6. `readInvoiceCorrectionInventoryValues` supplies exact remaining-stock values. Unknown custody/value is shown as unverified, never calculated by multiplying rounded unit rates. The UI shows component amounts, remaining-stock value, order cost basis and existing approved historical destinations before approval. It does not call every order-cost row a proven sale.
7. `recordInvoiceCostReview` appends the operational audit and, for a linked PO line, `invoice_cost_components_approved` into the existing immutable PO event stream. It retains actor/name, current authority, timestamp, reason, command key, selected sources/application and the reviewed before/after. Failure to retain that approval rolls back every business write and leaves the existing command retry mechanism in control.

The existing tax and origin-repair commands explicitly use nested execution: they stage components before applying their complete approved change. Their own measured preview, authority and transaction remain the approval owner. They do not require a second standalone component approval.

## Scope and compatibility

Bills, payments, receiving configuration, physical counts and shipment allocations retain their owners. A supplier split edit does not create an expense or assert that goods were sold. Receipt-specific pricing still uses approved explicit receipt assignments; uncovered quantities stay provisional. Missing split, credit attribution, unsupported currency and unknown custody are not guessed.

The source/request schema retains optional preview fields for reading old requests and committed results; the public command enforces a required preview for every new write. A predeployment preview must be refreshed because the reviewed contract now includes authority and exact values. No migration or historical monetary backfill is needed.

Full source coverage, ordinary AP state-transition review, combined unknown-split totals, credit/header adapters, downstream recognition and consumer convergence remain separate gates in the [remaining delivery list](procurement-costing-remaining-delivery.md). This slice does not close S2 or assert live financial acceptance.

## Acceptance

The real PostgreSQL cases are `invoice-cost-task-review.cases.ts` (registered by `receiving-cost-application.integration.test.ts`) and `invoice-cost-review.integration.test.ts`. They cover public preview/save, exact stock values, missing/stale previews, persisted/revoked authority, concurrent approvals, replay, legacy receipts, operational and retained-approval failures, no document/physical changes, and payment-only authority stability. Existing tax/origin/receipt/freight regressions exercise nested owners.

`supplier-cost-review-workflow.spec.ts` runs the actual receiving and supplier review UI against real HTTP/DB owners on desktop and mobile: $25 product/$0 packaging becomes $20 product/$5 packaging, total stock value and bill stay unchanged, the other PO's stock stays unchanged, and one retained approval records the exact changes. Mocked UI cases additionally prove unknown values and read-only roles. Final counts and hosted acceptance are recorded on the PR and in the main tracker; these are separate from production acceptance.
