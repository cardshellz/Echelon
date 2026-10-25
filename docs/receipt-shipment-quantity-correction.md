# Receipt and shipment quantity corrections

A posted receipt can contain a mistaken pieces-per-receiving-unit conversion even when its handled unit count is correct. Correcting that conversion must keep the receipt, purchase-order received totals, shipment manifest and cost applications consistent.

## Scope

- **Edit shipment** changes shipped pieces and optionally corrects linked posted receipts in the same modal. **Correct received quantities** remains the receipt-page entry point.
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

`ShipmentQuantityEditor` and `ReceiptShipmentQuantityCorrection` share the review and approval UI, with separate shipment and receipt inputs. A shipment edit accepts no received quantities: the server loads them under lock and preserves posted receipt rows, PO receipt postings, received totals, cost origins, and stock movements. The shipment page initially preserves saved receipt quantities. Selecting **Also correct received quantities** switches the same draft to the existing combined correction command. A single receipt covering the original shipment defaults to the proposed shipped pieces, with explicit overrides; partial or multiple receipts keep their saved quantities. The draft, reason and overrides survive scope changes and returning from preview. Inspection links open separately rather than discarding the draft.

The shipment input is available for any non-cancelled shipment. Before receiving, new receipts use its current quantity. When one linked receipt is still open, the same transaction refreshes its expected units from shipped pieces minus posted receipts, using that receipt's saved unit conversion. Entered received/damaged counts stay unchanged. Multiple open receipts or missing/ambiguous unit evidence require resolving the named receipt first; the editor links directly to it rather than guessing a split.

The server resolves receipt links using persisted relationships; a historical unlinked receipt must identify exactly one shipment line. It never copies today's catalog conversion into old receipts without an explicit reviewed correction.

`planQuantityCorrection` validates receipt coverage, whole-unit conversions, PO capacity and existing origin intervals. It preserves interval gaps and computes the corrected received balance. `correctedReceiptLifecycle` preserves an already closed PO and updates the receiving progress of an open PO.

`createReceiptShipmentQuantityCorrectionService` orchestrates the existing purchase, shipment and COGS owners under the inventory cost-graph lock and source row locks. Preview runs those owners in a savepoint and rolls it back. Approval requires the same source and impact fingerprints, current Administrator authority, a reason and source confirmation. Financial-command identity makes retries replay the saved response; concurrent different commands cannot approve the same source twice. Unexpected failures roll back all document and cost writes.

The transaction recomputes invoice matching against the corrected receipts without changing invoice amounts, ordered quantities or payment records. Closed and costing shipments refresh finalized costs; earlier shipment stages refresh allocations and explicitly retain the finalization action. The workflow does not publish an obsolete snapshot as newly posted costs.

Shipment edits recompute physical totals for measurements per piece and preserve measurements per carton. Shipment header totals, allocation bases, exact landed costs, inventory and sold-order costs use their existing owners. The preview shows receiving expectations, actual receipt counts, physical totals, cost totals and downstream postings. Shared purchasing invalidation refreshes the shipment, receipts, PO, inventory, finance and dashboard reads after approval or an ambiguous response.

`/api/shipment-lines/:id/shipment-edit` has a separate financial-command scope from receipt corrections. Both endpoints require current Administrator membership and purchasing approval. The shipment and combined entry contexts fingerprint the same source graph; the selected endpoint revalidates its own eligibility under lock. The combined form sends one financial command for both documents, never sequential independent saves. Both pending receipt expectations and posted unit conversions honor quarantine custody protections. They share the locked preview/apply transaction, immutable amendment records, stale-preview checks and idempotent command results. Existing receipt APIs and historical approval payloads remain readable.

When historical stock has no provable destination, the existing reconciliation policy determines whether an explicit historical COGS or inventory-expense decision is eligible. An eligible unresolved decision is required on the server before approval. An existing approved destination is carried forward, preserving its original immutable records. Other missing supplier evidence or protected costs stay visible with the existing cost-resolution actions inside the same review.

## Persistence and ownership

- Procurement owns `receipt_shipment_quantity_amendments` and `receipt_shipment_quantity_results`: actor, date, reason, source evidence and before/after result. A deferred constraint requires a completed result in the same transaction.
- Inventory owns `lot_cost_origin_amendments` through `recordCostOriginAmendment`. Original origins remain immutable. The effective-origin view supplies the current approved conversion and intervals to cost applications, origin repair, COGS and future receipt-origin recording.
- All three audit tables reject updates, deletes and truncation. The inventory amendment trigger verifies purchase and shipment ownership. New receipt origins append after the greatest effective interval endpoint, preserving gaps without overlap.
- PO events, PO history and shipment history record the same approval. Shared purchasing invalidation and receipt readback refresh the connected screens.

The migration is additive and must deploy before the application uses the effective-origin view. It does not correct any existing quantity or infer historical financial evidence.

## Verification

Domain and HTTP tests cover invalid quantities, conflicting ownership, capacity, partial receipts, closed PO status, permissions and command scope. Disposable PostgreSQL tests use the real receiving, supplier-cost, shipment-cost, inventory transfer and sold-COGS owners. Cases cover preview rollback, exact posting, duplicate submission, concurrency, stale evidence, revoked authority, downstream failure, retained historical approval, explicit accounting decisions, unfinalized shipments and later receipts after interval amendments.

Desktop and mobile browser tests exercise the shipment and receipt entry points, optional combined receipt editing, override and draft preservation, read-only posted receipts on shipment-only edits, before/after review, saved approval details, non-admin access, and retry after a lost response. PostgreSQL cases include both a 20,000-to-200,000 manifest correction with an already-correct receipt and a combined correction of both records (20 receiving units, 1,000 to 10,000 pieces each), pending receipt expectations, physical totals, transferred stock and sold COGS. These cases use fictional data; they do not constitute production acceptance.
