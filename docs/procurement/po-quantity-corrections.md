# Approved purchase order edits

`procurement.purchase_order_lines.order_qty` is the current ordered quantity, in base pieces. An approved edit changes that authority and recalculates its dependents. Actual received, shipped, invoiced and sold quantities remain independent records.

## Operator flow

Open **Edit PO**, change the prefilled compact line rows, enter a reason or supplier reference and choose **Review changes**. The review shows changed fields, PO totals/status, actual quantities, remaining receipt/shipping/invoice balances, shared-shipment allocations, inventory costs and cost-of-goods-sold changes. Previously approved historical costs and real remaining cost work are shown separately. Expand a cost section for its before/after records. Unresolved work links to the existing cost or receiving review.

Confirm the review and choose **Approve & save PO**. The PO History tab retains the same review with revision, approving user, date and reason. A lost response retains the exact approval request and idempotency key; **Retry saved approval** recovers the original result, including after closure. Connected purchase, shipment, receiving, invoice, planning, inventory, COGS and finance queries are invalidated after a settled approval attempt. Inactive readers reload on navigation.

From an invoice, **Edit PO** opens this same editor with a route back. Invoice corrections and the receipt/shipment correction flow remain explicit operations for correcting their actual document counts. A PO edit does not turn an ordered piece into a receipt, shipment, sale or invoice.

## Authority and commercial rules

Approval requires current active system Administrator membership and an unrestricted `purchasing:approve` grant, checked in the transaction. Configured PO amount/role tiers apply to the revised total. A session role label cannot authorize the edit.

Product rows support quantity, piece price or product total, packaging, discount and tax. Keeping a piece price recomputes the product total; keeping the product total recomputes its unit rate. Purchase-unit quotes require complete purchase units. Charge/credit rows have an exact signed amount. Currency calculations use integer cents/mills and BigInt. Header charges are preserved. Inconsistent original components require explicit reviewed amounts; missing supplier evidence is never inferred.

Approved through received POs use this amendment. Closed POs require explicit closed-document confirmation and retain closure; the commercial correction cannot exceed received goods or reopen receiving. Drafts use their existing guarded editor. Cancelled/short-closed purchases, accepted recommendation-owned purchases, returns/cancellations and dependent adjustments retain their owning-workflow guards.

Confirmed supplier invoice cost evidence retains authority over product and packaging costs. A PO edit refreshes those cost owners; it cannot silently replace an approved supplier invoice with a different PO price. Invoice quantities, amounts and payments stay recorded. Invoice matching and quantity exceptions are reevaluated against the current PO; superseded exceptions retain their original evidence in history.

## One transaction and one measured review

`createPoQuantityAmendmentService` acquires the common inventory cost-graph lock, locks the PO and dependent source records, freezes approval policy, and verifies the source fingerprint. `planQuantityAmendment` produces exact commercial changes. `persistQuantityAmendment` writes the PO, revisions/status, invoice matches and superseding exceptions.

`refreshPoAmendmentCosts` then calls the existing product/packaging cost application owner and shipment costing owner. Value-based allocation includes every line on a shared shipment, including other POs. Open shipments refresh allocation and explicitly remain pending finalization. Costing/closed shipments use audited finalization and adjust exact inventory totals, sold-item costs and previously approved historical-cost balances through their existing owners. Actual quantities and shipment charges are not rewritten.

Preview executes these same operations inside a savepoint and rolls them back. Approval reruns them and verifies a fingerprint of the measured review before committing. Temporary allocation/application IDs are excluded from the displayed issue contract; full issue evidence stays in the owning immutable cost applications. Quantities, financial effects, source identity and current issues remain bound to the approval.

Any write failure, stale source or changed measured result rolls back the entire edit. The durable financial-command ledger protects retries. Complete dependency reads are bounded; oversized or malformed evidence fails instead of committing a partial traversal. Existing historical approvals retain their destinations. The preview uses `readPurchaseCostStatus` and `isShipmentCostLinePosted`, so a retained historical warning cannot contradict a current posted result.

The immutable PO event records actor, reason, command key, source version, monetary approval evidence, complete PO before/after and measured downstream impact. History is permission-gated and paginated. No new migration is needed for the PO edit extension; the receipt/shipment correction feature in this PR has its separately documented migration.

See [the ordered quantity consumer trace](po-ordered-quantity-consumers.md) for read/write ownership and validation coverage.
