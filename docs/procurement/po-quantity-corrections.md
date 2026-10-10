# Edit purchase orders

Open the PO and choose **Edit PO**. Quantities, prices and line charges are prefilled. Edit the values you need, enter a reason or supplier reference, then choose **Review changes**. The review shows changed quantities and amounts, current and new PO totals, and receiving status. Confirm the review and choose **Approve & save PO**. Actions stay inside the modal while line details scroll.

An active user must have current system **Administrator** membership and an unrestricted `purchasing:approve` grant. Existing configured PO amount/role approval tiers apply to the new total. The administrator approves directly in this form. Session role strings cannot authorize the command.

Product lines support editable piece quantities, product prices, packaging totals, discounts and taxes. Quantity changes keep the prefilled pricing basis: a piece price recalculates the product total; an exact product total recalculates the derived piece price; a purchase-unit quote requires whole purchase units. The administrator can switch between a piece price and a product total. Price-only edits are supported. Fee, tax, rebate, discount and adjustment lines have one editable charge/credit amount; identities and quantities stay fixed. Parsing and calculation use exact integer cents/mills and BigInt.

The product price excludes separately recorded packaging. A warning identifies legacy totals that do not equal their components. All components must be explicitly reviewed to replace an inconsistent total; missing supplier evidence is never guessed. All active product lines must reconcile before saving. Header-level discount, tax and freight remain unchanged.

Saving edits the PO. Posted receipt quantities, receiving units, stock quantities/costs, invoice quantities/amounts and payments retain their records. Invoice matching is recalculated against the revised PO, and prior match variance approvals are superseded. Credits and document charges do not require a physical receipt. A PO price edit does not revalue stock or COGS; inventory cost evidence has its own owner.

Approved, sent, acknowledged, partially received and received POs are supported. Drafts use the normal editor. Terminal POs, accepted recommendation-owned POs, closed/cancelled lines, lines with returns/cancellations and dependent adjustments remain blocked with an explanation. Review and send the revised document through the existing workflow when needed.

The existing quantity-amendment endpoint and durable command ledger are reused. The server locks source rows, verifies the reviewed source hash and current approval authority, then atomically saves lines, reconciled totals/status, field revisions, history, invoice matches, exceptions and an immutable `line_amendment_approved` event. The event includes actor, reason, command key, approval/tier evidence and complete before/after state. Legacy quantity-only requests and committed retry receipts remain supported.

An uncertain response retains the exact body and idempotency key in browser session storage. **Retry saved approval** confirms the original outcome, including after PO closure. A permission denial before ledger lookup also retains the unresolved receipt. Stale evidence requires reloading and reviewing the current PO. Failed writes roll back the entire revision.

Owner paths: `po-quantity-amendment.policy.ts` (pricing/status policy), `po-quantity-amendment.repository.ts` (locked evidence and atomic persistence), `po-quantity-amendment.service.ts` (authorization and command orchestration), `po-quantity-amendment.routes.ts` (HTTP), and `PoQuantityAmendment.tsx` (edit/review/approval/recovery UI).

Validation covers unit policies/contracts, real disposable PostgreSQL constraints and transaction/concurrency guarantees, and mocked desktop/mobile interactions. Tests do not change production data. No migration is required.
