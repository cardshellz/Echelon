# Purchase order quantity corrections

Open the PO and choose **Correct quantities**. Change the quantity in base pieces, choose the price treatment for each changed line, and enter the supplier reference or correction reason. **Review correction** shows the before/after quantities, product amounts, unit prices, PO total, receiving status and aggregate invoice matches. Confirm the review and choose **Approve & apply correction**.

An active user must have both current system **Administrator** membership and an unrestricted `purchasing:approve` grant. Existing configured PO amount/role approval tiers also apply. Session role strings and client-supplied actor fields cannot authorize the command. This is an explicit approval by the administrator using the form; it does not introduce a separate requester/approver queue or require two different people.

Price treatments:

- **Keep product amount** preserves the recorded extended product amount and derives an exact new piece price, including the rounding residual.
- **Keep recorded quoted rate** preserves a recorded piece or purchase UOM rate and recalculates the product amount. A purchase UOM quote requires a whole number of that UOM. For legacy or extended-total quotes, the preview warns that this uses the normalized piece rate.

Packaging, discount, tax and freight amounts remain fixed. Receipts, receiving units, inventory quantities/costs, invoice quantities/amounts and payments retain their original records. Changing the PO does not correct an erroneous receipt or vendor invoice; use the workflow that owns that record. Invoice match status is recalculated, and prior match variance approvals are superseded. Remaining match issues require review before closing the PO.

The action supports approved, sent, acknowledged, partially received and received POs. Drafts use the normal editor. Terminal POs, accepted recommendation-owned POs, closed/cancelled lines, lines with cancellations/returns and lines with dependent adjustments are blocked with an explanation. There is no automated vendor notification; review and send the revised document through the existing document/email workflow when needed.

The server locks the cost graph, PO and source rows; verifies a hash of the reviewed commercial, receipt, invoice, exception and approval evidence; then atomically saves the line changes, reconciled totals/status, revision/history, invoice match results, current exceptions and immutable `quantity_amendment_approved` event. The event records actor, reason, permission/tier evidence, command key, timestamps and complete before/after PO state. Stale evidence rejects the command without changing the PO.

Approvals use the durable financial command ledger. Browser session storage retains the exact request and idempotency key across reloads after an uncertain response. Retry the saved approval to obtain the committed result. A permission denial before ledger lookup retains the unresolved key; restore appropriate access to confirm the outcome. Terminal POs expose the saved approval recovery action while continuing to reject new corrections.

Owner paths: `po-quantity-amendment.policy.ts` (pure pricing/status policy), `po-quantity-amendment.repository.ts` (locked evidence and atomic persistence), `po-quantity-amendment.service.ts` (authorization, versioning and command orchestration), `po-quantity-amendment.routes.ts` (HTTP), and `PoQuantityAmendment.tsx` (review/approval/recovery UI).

Validation uses unit policy/contract tests, a disposable PostgreSQL suite with real price/audit/command constraints, and mocked desktop/mobile browser tests. No migration, deployment or live document correction is performed by these tests.
