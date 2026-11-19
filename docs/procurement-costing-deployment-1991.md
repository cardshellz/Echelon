# #1991 deployment and live review verification

Checked 2026-11-03. This verifies the release and a real rollback-only preview; it does not claim a production financial approval was posted.

- PR #1991 merged at `209f40c11c669289be0e0cbc8bc8e2157da28cf9` (2026-11-03 19:52:56 UTC). Final PR head `673eaf2be92826d070eb81446e04a7cb108cad4f` has 63/63 successful checks.
- Heroku `cardshellz-echelon` v3454 succeeded at 19:54:16 UTC. Slug `893a4667-5594-4416-adca-8a7b95925068` identifies that exact merge commit. `web.1` and `inventory-capture.1` were up on release `94e84f3d-6413-4199-94d7-c532a4eec258`.
- `_migrations` records `900000051000019910001_ap_invoice_transition_reviews.sql` applied at 19:54:31.590481 UTC. The actual manifest schema is defined in `migrations/run-migrations.ts`.
- At 20:10:51 UTC, read-only PostgreSQL counts were zero for receipt assignments, receipt-enabled PO lines, invoice-transition reviews, standalone supplier approvals and freight approvals. There is no actual approved production example for those new owners to inspect.

## Actual live UI exercise

Opened the authenticated live invoice list and **INV-20260520-001 / invoice 143**. Its Dispute action opened the deployed review form. Entered the explicitly non-authorizing reason “Read-only deployment verification; do not save this proposed dispute.” and requested **Review changes**. `createInvoiceTransitionPreview` / `reviewInvoiceTransitionInTransaction` returned the actual before/after, original approval, exact stock values, order cost basis and owning review issues. This was the existing rollback-only preview, not an approval.

The proposed status was partially paid → disputed; the bill, cash paid and balance were unchanged in the preview. Closed it with **Close review**, leaving no dialog and the live invoice visibly **partially paid**. No Dispute invoice confirmation was submitted.

Independent read-only PostgreSQL readback after closing:

| Field | Before observed in UI | After database readback |
| --- | --- | --- |
| Invoice status | partially paid | `partially_paid` |
| Invoice amount | $35,311.00 | 3,531,100 cents |
| Cash paid | $10,593.30 | 1,059,330 cents |
| Balance | $24,717.70 | 2,471,770 cents |
| Original approval | May 20, 2026, 09:16:41 Eastern | `2026-05-20 13:16:41.909` UTC |
| Retained transition reviews | 0 | 0 |
| Verification-reason audit rows | none submitted | 0 |

The preview exposed existing protected components, unverified valuation and historical outflow/sale-coverage issues. Those are actual owning review results, not evidence that a dispute was saved. No quantities, sources, approvals or costs were repaired during this verification. Source: `ap-invoice-transition.service.ts`, `ap-invoice-transition.routes.ts`, the live UI, and the two explicit `BEGIN READ ONLY ... ROLLBACK` database readbacks.

Next acceptance remains an evidence-backed real financial approval through its owning workflow when an operator has an actual document to approve. Tests and this preview do not substitute for that production acceptance.
