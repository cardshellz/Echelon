-- Correct migration 113's predicate in environments where the original
-- non-cancelled index may have succeeded. The intended database guard is for
-- active in-flight shipment receipts only; closed historical receipts are
-- handled by service-level duplicate checks and audit reporting.

DROP INDEX IF EXISTS procurement.receiving_orders_shipment_po_active_uidx;

CREATE UNIQUE INDEX receiving_orders_shipment_po_active_uidx
  ON procurement.receiving_orders (inbound_shipment_id, purchase_order_id)
  WHERE inbound_shipment_id IS NOT NULL
    AND purchase_order_id IS NOT NULL
    AND status IN ('draft', 'open', 'receiving', 'verified');
