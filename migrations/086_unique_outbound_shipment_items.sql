-- Ensure a shipment can only carry one row per WMS order item.
-- Duplicate rows caused the ShipStation shipment-push validator to double-count
-- line totals and dead-letter otherwise valid shipments.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY shipment_id, order_item_id
      ORDER BY id ASC
    ) AS row_num
  FROM wms.outbound_shipment_items
  WHERE order_item_id IS NOT NULL
)
DELETE FROM wms.outbound_shipment_items osi
USING ranked r
WHERE osi.id = r.id
  AND r.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_outbound_shipment_items_shipment_order_item
  ON wms.outbound_shipment_items (shipment_id, order_item_id)
  WHERE order_item_id IS NOT NULL;
