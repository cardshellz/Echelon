# Historical receipt cost origin repair

Depleted legacy lots can have a valid receipt and posted freight but lack the
saved receipt case factor and cost-source link required for product/packaging
costs. The shared supplier-cost review provides **Repair historical cost origin**
for those lots and **View origin repair and approval** after approval.

## Approval and posting

`createCostOriginRepairService` checks an active system Administrator role with
an unconstrained purchasing approval grant, including at submission time. The
operator confirms the case factor, complete supplier invoice product/packaging
split, historical cost destination and a supporting reason. Suggested PO values
are clearly distinguished from confirmed supplier evidence.

The preview executes the existing invoice-component, receipt-origin and cost
owners inside a savepoint and rolls it back. Approval checks the source and full
downstream financial history version, repeats the same calculation and verifies
its before/after result. One idempotent transaction preserves the original
receipt evidence, appends its missing cost interval, posts approved historical
supplier costs and rebinds existing freight approvals without duplicating their
amounts. Existing immutable receipt intervals are never rewritten.

The repair audit has one writer, the Procurement command owner, enforced by the
writer-ownership guard. Financial postings remain owned by Inventory.
The approval retains actor, reason, timestamp and exact before/after amounts.
Completed dialogs show the approval rather than a disabled posting action.
Current PO, receipt, shipment, dashboard and history status verifies current
sources, lot coverage, component balances, historical ledger and reporting
evidence. Old attempts remain visible as history.

## Boundaries and failures

This command covers a unique depleted original receipt lot with no recorded
order costs or transformations. Conflicting source evidence, incomplete invoice
coverage, protected costs, physical commitments or unrelated lot-history gaps
fail before commit. A historical expense approval does not invent an individual
sale, change stock counts or change PO/invoice totals or payments. Future source
revisions post only the difference to the approved destination; restored history
reverses an obsolete historical allocation before assigning costs again.

Migration and application deploy together. Reporting consumers must accept
product/packaging historical adjustments under the existing versioned report
contract. Operational deployment and live administrator approval remain
separate from local test evidence.

## Verification

Permanent disposable-PostgreSQL tests exercise both missing-origin shapes,
rollback-only previews, exact amounts, idempotent replay, competing approvals,
audit-write rollback, stale downstream history, revoked admin access, unrelated
history rejection, future source revisions and current shared status. HTTP tests
cover permissions, schema boundaries and sanitized failures. Desktop/mobile
browser fixtures verify before/after, approval visibility across screens,
read-only access and recovery from a lost success response.

A separate local replay used a bounded read-only capture of the affected
financial histories with synthetic customer/order identities. Detailed live
records and monetary results are retained in local task evidence and are not
included in the public test fixtures.
