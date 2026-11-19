# #1993 deployment and live verification

Checked 2026-11-04. PR #1993 merged as `68bb9f0340c430eeadb80d10d145c01ff10818c2`; its final head `8196e358e0a8868822c32173631ed17059bbb377` has 63 successful checks. The current v3461 release succeeded at 18:46:10 UTC, slug `e0d03026-e02a-4f3c-b921-1545b8696000`, commit `9cf76be54f121ecb611e3adf8c3f4856e09f08dd`. Git ancestry proves that commit includes #1993. Both `web.1` and `inventory-capture.1` were up on v3461. Migration `900000052000019930001_receipt_supplier_credit_sources.sql` was applied at 2026-11-04 13:44:08.419789 UTC.

The authenticated live Administrator opened invoice 143's supplier review and the deployed billed-adjustment controls: reference, amount, discount/freight/other type, and product/packaging/outside-inventory destination. Closed it without saving. No missing supplier split was invented.

For the actual rollback-only owner, opened paid invoice **INV-20260511-002 / 139**, line 5 / 197, whose saved operator review already records product $1,510 and packaging $295. Kept those saved values, entered the non-authorizing reason `Deployment verification of 1993; preview only`, and requested **Review cost changes**. The real preview returned $1,510 → $1,510 product, $295 → $295 packaging, $0 adjustments and before/after stock values. It retained real unresolved valuation reasons. Closed with **Close review**; never submitted **Approve and apply costs**.

Independent `BEGIN READ ONLY ... ROLLBACK` database reads before and after confirmed:

| Evidence | Before | After |
| --- | --- | --- |
| Invoice status | paid | paid |
| Invoice / cash paid | 6,465,550 / 6,465,550 cents | same |
| Applied credit / balance | 0 / 0 cents | same |
| Original approval | `2026-05-11 21:36:17.335` | same |
| Line 197 bill | 180,500 cents | same |
| Saved component evidence MD5 | `cacafba9d18f7b238b7df36aefa72aca` | same |
| Audit rows containing verification reason | 0 | 0 |

The live supplier-credit create view loaded the same approved invoice and the two reviewed lines' product/packaging source choices. Cancelled the unsaved form. Production has **zero supplier-credit documents, zero receipt-costing-enabled PO lines, zero saved receipt/invoice assignments and zero receipt-credit cost approval events** at this readback. Therefore a real receipt-credit posting/reversal cannot be verified from existing production records; SQL-backed acceptance remains separate from actual-record acceptance. No financial posting, assignment, supplier split, historical repair or stock change was submitted.

Sources: read-only Heroku releases/slug/dyno APIs, `_migrations`, `vendor_invoices`, `vendor_invoice_lines`, `receipt_invoice_cost_allocations`, `purchase_order_lines`, `supplier_credits`, `po_events`, `audit_events`, and the visible invoice/credit UI. The deployed #1998 identity changes are included in the baseline; this live review also verifies that the current persisted Administrator can use the deployed preview owner.
