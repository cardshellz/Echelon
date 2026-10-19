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
- Preserve original cost origins; effective cost intervals incorporate approved amendments. Revalue all affected purchase and shipment scopes, including later receipts whose source intervals move.
- Clearly distinguish posted cost changes from genuine unresolved history, with a direct existing reconciliation action.

## Exclusions and fail-closed cases

This corrects the piece meaning of already handled receiving units. Changing physical unit counts uses inventory's receipt/reversal workflow. Ambiguous links, reversal/damage conflicts, invalid whole-unit conversion, manual cost protections and stale previews require explicit resolution rather than guessed history. Ordinary partial deliveries do not automatically rewrite manifests or commercial orders.

