# Receipt and shipment quantity corrections

A posted receipt can contain a mistaken pieces-per-receiving-unit conversion even when its handled unit count is correct. Correcting that conversion must keep the receipt, purchase-order received totals, shipment manifest and cost applications consistent.

## Scope

- One shared review opened from a receipt, shipment or purchase order.
- Explicit correction of shipped pieces and the piece quantities of linked posted receipt lines.
- Preserve physical receiving-unit counts, stock movements, ordered quantities, invoices and supplier charges.
- Show document identities, current and proposed piece conversions, PO received balance, charge allocation and downstream cost results before approval.
- Require an active Administrator with purchasing approval permission, current source version, supporting reason and explicit confirmation.
- Keep an immutable amendment record with original evidence, approver, before/after and result. Repeated submissions replay the same result.
- Apply corrections and cost-owner work in one transaction. A failed command commits neither quantity changes nor cost changes.
- Preserve original cost origins; effective cost intervals incorporate approved amendments. Revalue affected purchase and shipment scopes, including later receipts whose source intervals move.
- Clearly distinguish posted cost changes from genuine unresolved history, with a direct existing reconciliation action.

## Exclusions and fail-closed cases

This corrects the piece meaning of already handled receiving units. Changing physical unit counts uses inventory's receipt/reversal workflow. Ambiguous links, reversal/damage conflicts, invalid whole-unit conversion, manual cost protections and stale previews require explicit resolution rather than guessed history. Ordinary partial deliveries do not automatically rewrite manifests or commercial orders.

## Implementation and authority

`ReceiptShipmentQuantityCorrection` is the same editor on the PO, shipment and closed receipt. The server resolves receipt links using persisted relationships; a historical unlinked receipt must identify exactly one shipment line. It never copies today's catalog conversion into old receipts without an explicit reviewed correction.

`planQuantityCorrection` validates receipt coverage, whole-unit conversions, PO capacity and existing origin intervals. It preserves interval gaps and computes the corrected received balance. `correctedReceiptLifecycle` preserves an already closed PO and updates the receiving progress of an open PO.

`createReceiptShipmentQuantityCorrectionService` orchestrates the existing purchase, shipment and COGS owners under the inventory cost-graph lock and source row locks. Preview runs those owners in a savepoint and rolls it back. Approval requires the same source and impact fingerprints, current Administrator authority, a reason and source confirmation. Financial-command identity makes retries replay the saved response; concurrent different commands cannot approve the same source twice. Unexpected failures roll back all document and cost writes.

The transaction recomputes invoice matching against the corrected receipts without changing invoice amounts, ordered quantities or payment records. Closed and costing shipments refresh finalized costs; earlier shipment stages refresh allocations and explicitly retain the finalization action. The workflow does not publish an obsolete snapshot as newly posted costs.

When historical stock has no provable destination, the existing reconciliation policy determines whether an explicit historical COGS or inventory-expense decision is eligible. An eligible unresolved decision is required on the server before approval. An existing approved destination is carried forward, preserving its original immutable records. Other missing supplier evidence or protected costs stay visible with the existing cost-resolution actions inside the same review.

## Persistence and ownership

- Procurement owns `receipt_shipment_quantity_amendments` and `receipt_shipment_quantity_results`: actor, date, reason, source evidence and before/after result. A deferred constraint requires a completed result in the same transaction.
- Inventory owns `lot_cost_origin_amendments` through `recordCostOriginAmendment`. Original origins remain immutable. The effective-origin view supplies the current approved conversion and intervals to cost applications, origin repair, COGS and future receipt-origin recording.
- All three audit tables reject updates, deletes and truncation. The inventory amendment trigger verifies purchase and shipment ownership. New receipt origins append after the greatest effective interval endpoint, preserving gaps without overlap.
- PO events, PO history and shipment history record the same approval. Shared purchasing invalidation and receipt readback refresh the connected screens.

The migration is additive and must deploy before the application uses the effective-origin view. It does not correct any existing quantity or infer historical financial evidence.

## Verification

Domain and HTTP tests cover invalid quantities, conflicting ownership, capacity, partial receipts, closed PO status, permissions and command scope. Disposable PostgreSQL tests use the real receiving, supplier-cost, shipment-cost, inventory transfer and sold-COGS owners. Cases cover preview rollback, exact posting, duplicate submission, concurrency, stale evidence, revoked authority, downstream failure, retained historical approval, explicit accounting decisions, unfinalized shipments and later receipts after interval amendments.

Desktop and mobile browser tests exercise the shared editor from PO, shipment and receipt, before/after review, saved approval details, non-admin access, and retry after a lost response. These browser cases use fictional API fixtures; they do not constitute production acceptance.
