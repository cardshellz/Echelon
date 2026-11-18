# PR #1979 deployment and read-only live verification

Verified 2026-11-02 UTC (2026-11-01 America/New_York). This separates deployment, available UI, and actual financial acceptance.

| Evidence | Observed result |
| --- | --- |
| PR | #1979 merged at `aed77192e55567451cfedc85fecd3fd30f21159c` on 2026-11-01T23:33:22Z |
| Final merged PR head | `403571fd440753878745a454467f4c486f298bcf`; all 75 checks succeeded |
| Changes since previously tested head `8716f1ee9` | 21 customer-account/returns files; no procurement costing implementation changes |
| Current main / deployed slug commit | `5407e8938999f8967aab2f4265849f8cab533a2d`; merge ancestry verified |
| Release | `cardshellz-echelon` v3445, succeeded; created 2026-11-02T00:14:46Z |
| Slug | `aedfebbc-8204-4369-8c8c-6abc03786f8a`; full commit verified through Heroku Platform API |
| Processes | `web.1` and `inventory-capture.1` up on v3445 / release `382ee4db-2a38-4428-b265-b72f70c63872` |
| Migration | Release output reports `900000047000019790001_receipt_invoice_cost_allocations.sql` already applied, then release phase complete; read-only SQL successfully reads its table and flag |
| Current deployed commit CI | All 27 checks succeeded |
| Original merge CI caveat | 24 successful, two cancelled SQL shards, one failed aggregate requiring those shards. Aggregate log reports cancellation, not a failed test assertion. The cancellation cause was not established. Current deployed-commit checks are separately green |

No procurement/inventory/shared purchasing/receipt-cost UI differences were found between the final PR head and the deployed commit in the scoped comparison.

## Production data actually present

Read-only, 15-second statement-limited transactions found:

- `procurement.receipt_invoice_cost_allocations`: **0 rows**.
- PO lines with `receipt_costing_enabled=1`: **0**.
- `public.audit_events` with action `procurement.receipt_invoice_costs.approved`: **0**.

The migration intentionally defaults historical lines to disabled and does not infer invoice-to-receipt assignments. No live administrator has used the new allocation approval flow in this snapshot. Therefore separate approved invoice prices, partial approved coverage, and downstream posting under this policy cannot be claimed live-verified. The pre-deployment SQL/browser acceptance is evidence for the implementation, not a substitute for that missing production event.

## Authenticated UI and inventory cross-check

On PO `PO-20260520-002` / line 191, the live lifecycle cost review opens **Receipt invoice costs**. Its loaded editor identifies the saved receive conversions and displays:

| Receipt | Saved count | Pieces per count | Pieces | Assigned invoice-cost pieces shown | Provisional coverage shown |
| --- | ---: | ---: | ---: | ---: | ---: |
| RCV-20260723-001 / receiving line 2703 | 20 | 10,000 | 200,000 | 0 | 200,000 |
| RCV-20261027-001 / receiving line 2723 | 80 | 10,000 | 800,000 | 0 | 800,000 |

The editor also correctly states that the supplier invoice needs product/packaging/tax evidence before assignment. No assignment, preview approval, supplier evidence or financial posting was submitted.

The original inventory root for line 2703 has `cost_provisional=0`; the root for line 2723 has `cost_provisional=1`. These historical saved flags do **not** establish the new receipt-allocation policy: the PO line is not enabled, there are no mappings or new approvals, and the editor's coverage projection is not proof of a changed inventory flag. The historical cost sources and their manual protections require their own reviewed resolution. Neither flag was changed or automatically relabelled as successfully reconciled.

Concrete owner trace: `readReceiptInvoiceReviewSource` reads frozen receipt origins and current source evidence; `receiptInvoiceCostRows` projects supplier coverage. `persistReceiptInvoiceAllocations` enables a line only inside the administrator's approved command. `refreshReceiptProvisional` applies the new receipt-specific inventory flags through the existing cost application transaction after that approval.

## Acceptance still required

Use real supplier evidence to approve an explicit receipt/invoice assignment through the existing editor. Record its before/after, immutable approval and resulting source/application/lot state. A second receipt with a different actual invoice price and an uncovered remainder is needed to prove the requested production behavior. No real invoice-to-receipt relationship or product/packaging split may be invented to manufacture this acceptance case.

All production checks in this verification were read-only; SQL used `BEGIN READ ONLY`, a local statement timeout, and `ROLLBACK`. No physical quantities, bills, payments, costs or approvals were changed.
