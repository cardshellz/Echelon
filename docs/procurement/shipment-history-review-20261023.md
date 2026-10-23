# Shipment history review: S260312001590

Read-only production snapshot: 2026-10-23 22:30:03 UTC. No records were changed.

## Confirmed evidence

- Shipment 34 (`#S260312001590`) is Booked. `inbound_shipment_status_history` contains creation and booking on March 19, 2026 only. Departure/delivery dates and carrier observations are absent.
- Its four manifest lines (67–70) record 100,000 / 25,000 / 25,000 / 25,000 pieces. They link to PO 68, `PO-20260319-001`, lines 103–106. That PO is Closed, goods Received, financial Paid. Its ordered/received counters are 200,000 / 50,000 / 50,000 / 50,000.
- Receipts `RCV-20260319-001` (78) and `RCV-20260408-002` (101) were created against the PO. Neither header nor any of their five receiving lines links to the shipment. Saved receipt unit conversions are absent.
- For PO line 103, `po_receipts` records 200,000 pieces on receiving line 2281 and another 100,000 on line 2312, while the PO's received counter is 200,000. This is conflicting evidence, not proof that either receipt should be removed or reassigned.
- Five associated lots exist, all depleted. No effective lot cost origins or receiving-order-linked inventory transactions were returned. This bounded query does not establish the lots' downstream destination.
- Shipment charges total $1,651.91 across three charges and twelve allocations. No landed-cost snapshots or adjustments exist for these four shipment lines. Absence of these records does not establish that no costs were posted elsewhere.

## Consequences for correction

The system cannot infer the actual shipped quantities, departure/delivery dates or receipt membership from these records. An administrator must use the packing list / delivery evidence to confirm a status correction. This correction must not change quantities, associate receipts by SKU, manufacture cost origins, recalculate allocations or repost costs. Conflicting quantities remain visible and require documentary evidence through their owning quantity/receiving workflow.

The PO header defect is independent: `purchase-order-lifecycle.service.ts` deliberately maps Shipped / In transit / Arrived to legacy Acknowledged. `PurchaseOrderDetail` displayed that legacy field. The header and list must use the shared physical-status resolver while preserving Closed, Cancelled and approval decisions.
