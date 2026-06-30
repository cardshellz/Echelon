-- Ensure a shipment-linked receipt has one active in-flight header per PO.
-- Multi-PO shipments are represented as one receiving order per
-- (inbound_shipment_id, purchase_order_id), while multi-shipment POs may have
-- one receipt per shipment. Closed historical receipts are excluded because
-- duplicate closed rows already exist in production and receipt creation now
-- blocks re-receiving closed shipment/PO pairs at the service layer.

CREATE UNIQUE INDEX IF NOT EXISTS receiving_orders_shipment_po_active_uidx
  ON procurement.receiving_orders (inbound_shipment_id, purchase_order_id)
  WHERE inbound_shipment_id IS NOT NULL
    AND purchase_order_id IS NOT NULL
    AND status IN ('draft', 'open', 'receiving', 'verified');
