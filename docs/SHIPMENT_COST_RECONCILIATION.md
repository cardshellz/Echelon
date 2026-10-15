# Shipment cost reconciliation

The existing exception acceptance records a review decision only. It cannot
finish financial reconciliation. A correction must retain receipt and stock
history while giving every approved unresolved cost a durable financial
destination, with exact amounts, before/after evidence, approval authority,
transactional posting and safe retry behavior. A historical adjustment must
not invent an order, receive goods again, or change physical stock.

The implementation reuses the existing cost application, approval and durable
command owners. Real production investigation evidence stays local. Published
tests use synthetic records only.

## User flow

1. Update shipment costs from the PO or shipment. Known stock and order costs
   continue through the existing inventory cost application owner.
2. Choose **Reconcile costs** beside an unresolved shipment line. The review
   shows the recorded receipt, lot quantities, missing history and current
   financial postings together.
3. An administrator chooses **Cost of goods already sold** when supporting
   records prove a sale, or **Historical inventory cost adjustment** when the
   missing movements cannot be attributed to sales. Neither is preselected.
4. Review the unchanged shipment charge, tracked stock/order allocation,
   historical expense balances and unassigned amount before and after. Enter
   the reason or supporting reference, then **Approve & post costs**.
5. A successful posting leaves zero unassigned cost for the reviewed quantity.
   The PO and shipment show **Costs reconciled**, while retaining the original
   inventory-history evidence and posting history. Historical balances and
   activity are also available in Inventory Cost Dashboard > Adjustments.

This posts to Echelon's historical inventory cost subledger. Historical COGS
is explicitly unattributed to individual orders and is reported separately
from order-specific margin figures. Optional downstream reporting exports
immutable evidence; its acknowledgement is not a general-ledger posting.

## Ownership and integrity

- `shipment-cost-reconciliation.service.ts` coordinates the review and durable
  command. Approval requires an active member of the real system Administrator
  role with an unrestricted `purchasing.approve` grant, rechecked under identity
  locks. A display role string or an ordinary purchasing grant is insufficient.
- `inventory/domain/cost-reconciliation.ts` determines eligible amounts and
  historical quantity identity. `inventory/application/plan-cost-reconciliation.ts`
  plans changes, and the existing `applyCostRevision` owner applies them.
- Approval, signed postings, normal cost updates, immutable report evidence and
  the command result commit atomically. The inventory graph, shipment and
  identity locks serialize competing work. A stale preview cannot approve
  changed costs, stock evidence or an intervening decision.
- Amounts remain exact integer 1/10,000 USD. Each posting records before, after,
  signed delta and its equal opposite unassigned-cost delta. Foreign keys,
  predecessor balances and unique predecessor indexes prevent retargeting or
  branching balances. Updates, deletes and truncation of audit rows are rejected.
- Retrying an uncertain response uses the original command key. Competing new
  approvals are serialized and rejected when their preview is stale. An audit
  or reporting write failure rolls back the financial operation.

## Later corrections and remaining blockers

An approved destination follows later cost changes for the same historical
quantity. Increases, reductions and zero amounts produce signed differences;
they do not repeat the original expense. An administrator can change the
destination with another reviewed approval that reverses the first balance.
An estimated charge is explicitly identified in the approval review. Its saved
estimate can be reconciled; the later confirmed charge updates the posting.

Changed historical attribution invalidates the prior approval and reverses its
expense. When complete receipt and sold-order history is restored, the existing
cost owner assigns the tracked costs and reverses the historical expense in the
same transaction. Partial restored receipt coverage is rejected before either
side can double-count the shipment charge.

Missing receipt links are eligible only for depleted lots without existing
landed costs, current/legacy order costs, reservations, picks, transformations
or other known receipt roots for the same shipment line. Unknown amounts,
unsupported currencies, protected components and other unproven attribution
remain blocked with an explanation. This flow never invents an order, stock
movement or receipt. Earlier acknowledgement-only decisions do not substitute
for financial postings.

## Compatibility and validation

Review responses negotiate version 3 for reconciliation state. Version 2 strips
the additive field for already-open clients; older clients retain their prior
response shape. The legacy acknowledgement endpoint remains available but the
current UI determines completion from the financial ledger.

Regression coverage uses disposable PostgreSQL and synthetic records for
balanced posting, conservation across stock/orders/history, permissions and
revocation, races, stale previews, replay, rollback, subsequent price changes,
reclassification, complete/partial restored history, immutable audit and
report-payload verification. Browser coverage exercises desktop/mobile review,
non-admin access, approval, stale review, response-loss retry and saved results.

Deployment and a reviewed production approval are separate from these tests.
Production investigation evidence remains local and is not a test fixture.
