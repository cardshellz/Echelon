-- Ensure a shipment-linked receipt has one active header per PO.
-- Multi-PO shipments are represented as one receiving order per
-- (inbound_shipment_id, purchase_order_id), while multi-shipment POs may have
-- one receipt per shipment. Cancelled receipts are excluded so operators can
-- intentionally restart a discarded shipment receipt.

CREATE UNIQUE INDEX IF NOT EXISTS receiving_orders_shipment_po_active_uidx
  ON procurement.receiving_orders (inbound_shipment_id, purchase_order_id)
  WHERE inbound_shipment_id IS NOT NULL
    AND purchase_order_id IS NOT NULL
    AND status <> 'cancelled';
