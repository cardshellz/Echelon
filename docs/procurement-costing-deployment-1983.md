# Freight reconciliation deployment verification — 2026-11-02

This is read-only deployment evidence, not financial posting acceptance.

| Check | Verified result |
| --- | --- |
| PR | #1983 merged at `56c547ae5f8e0ff60e7d0570999a58f3b973ef92`; final PR head `cbd96f4e138d74b6b76260d2e942633f6cfdbfa7` |
| Release | `cardshellz-echelon` v3447, succeeded, created `2026-11-02T13:13:36Z` |
| Actual slug commit | `56c547ae5f8e0ff60e7d0570999a58f3b973ef92`, exactly the merge |
| Release identity | `59df4237-369a-4e3f-b000-6f1337602a61` |
| Processes | `web.1` and `inventory-capture.1` up on that same release |
| Migration | Release output records successful application of `900000049000019830001_freight_invoice_approval_history_lookup.sql`, one new migration, release phase complete |
| Post-merge CI | All 27 checks on the deployed full commit completed successfully |
| Production receipt assignments | 0 |
| PO lines with receipt costing enabled | 0 |
| Freight approval events | 0 |

Counts were read at `2026-11-02 13:41:00.221683+00` in `BEGIN READ ONLY`, with a 15-second statement timeout, then rolled back. The queries counted `procurement.receipt_invoice_cost_allocations`, lines with `receipt_costing_enabled=1`, and PO events with `event_type='freight_invoice_costs_approved'`. Sanitized CLI evidence is in ignored `.codex-artifacts/deployment-1983.log`; it contains no authentication token or signed release-output URL.

The deployed implementation and process/migration state are verified. Actual production receipt-price assignment and freight posting are **not proven**: there are no approved records to read back. No assignment, approval, bill, payment, cost or physical record was created or changed to manufacture acceptance. Historical mapping still needs source evidence and its existing administrator approval.
