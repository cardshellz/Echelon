# Supplier cost approval deployment verification — 2026-11-03

This is read-only release evidence. It does not manufacture a financial approval to claim live acceptance.

| Check | Verified result |
| --- | --- |
| PR | #1987 merged `2026-11-02T21:12:04Z` at `b0961153a2c028f7b40ac9fbb49fc66086815192` |
| Final PR head | `372feb9fa43986db9b7030ca1c4114cbe0a5a17e`; all 63 checks successful/skipped, no unsuccessful checks |
| Release | `cardshellz-echelon` v3453, succeeded, created `2026-11-03T01:27:08Z` |
| Actual slug commit | `6a43c7b656004d93b6fb182b6f10ba93f394ce77` (#1989); #1987 merge is an ancestor |
| Release identity | `6ec26016-585b-4999-9cd7-ffc35db2d52a` |
| Processes | `web.1` and `inventory-capture.1` up on that same release |
| Post-merge deployed-commit CI | 27 checks, no unsuccessful checks |
| #1987 migration | None; linked approval retention uses existing protected PO events |
| Receipt assignments / enabled PO lines | 0 / 0 |
| Freight / standalone supplier-review approvals | 0 / 0 |

The production counts were read at `2026-11-03 18:36:22.038609+00` in `BEGIN READ ONLY` with a 15-second statement timeout, then rolled back. They count `procurement.receipt_invoice_cost_allocations`, lines with `receipt_costing_enabled=1`, and PO events of types `freight_invoice_costs_approved` and `invoice_cost_components_approved`.

Fetched main was pinned to the deployed slug commit above. The procurement, identity, shared procurement and purchasing client source has no diff between the completed supplier-approval candidate `34d927a3fca34e45ab2c2eb98a48aab73d9238bd` and that deployed main. Deployment and process state are verified; production posting through these new reviewed flows remains unproven because there are no actual approved records. No bill, payment, assignment, cost or physical fact was changed during verification.
