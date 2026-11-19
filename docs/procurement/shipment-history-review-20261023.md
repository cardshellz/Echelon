# Purchase status and shipment history correction

## Status authority

The lifecycle service deliberately maps Shipped, In transit and Arrived to the compatibility Acknowledged status. PurchaseOrderDetail previously displayed that compatibility field. The header and list now use resolveCurrentPhysicalStatus from shared/procurement/purchase-order-status.ts, also used by lifecycle authorization. Closed, Cancelled and approval decisions retain their meaning.

## Historical correction boundary

A recorded receipt does not prove which shipment carried it. Missing shipment links, missing saved unit conversions and conflicting receipt counters are evidence gaps. Do not infer actual shipped quantities, departure/delivery dates or receipt membership from those records.

createShipmentHistoryCorrectionService provides context, preview and approval. An active system Administrator with unscoped purchasing approval permission must explicitly confirm the recorded manifest and documented dates. planShipmentHistoryCorrection reclassifies only that manifest. It does not edit quantities or associate receipts by SKU.

The context and preview use repeatable-read transactions. Approval reacquires the shipment/cost and identity locks, verifies the reviewed source and actor-bound preview, and writes the correction with the durable financial-command result. Before and after are saved in the immutable procurement.shipment_history_corrections table; a linked status-history event exposes the approval in Timeline. A second protected-record fingerprint rejects any unexpected quantity or cost write and rolls the transaction back.

The correction does not invoke cost allocation/finalization, create cost origins, post inventory or COGS, alter invoices, or reopen closed POs. Its dates and status change the shared relationship projection's planned/shipped classification. Existing quantity discrepancies remain visible with links to their source receipts.

## Validation and limits

Tests use fictional records and disposable PostgreSQL. They cover permissions, stale previews, concurrency, replay after lost responses, immutable audit history, rollback on an unexpected cost change, multi-PO shares, split shipments and returning to the same PO line. Production-specific evidence is retained locally rather than in this document. No production correction is performed by this PR; actual approval requires shipping-document evidence.
