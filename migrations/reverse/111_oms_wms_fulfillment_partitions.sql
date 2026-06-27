-- Reverse migration: 111_oms_wms_fulfillment_partitions
-- Restores the previous OMS-order-only active dedupe index.

DROP INDEX IF EXISTS wms.idx_wms_orders_oms_fulfillment_partition;
DROP INDEX IF EXISTS wms.uq_wms_orders_oms_fulfillment_partition_active;

ALTER TABLE wms.orders
  DROP CONSTRAINT IF EXISTS wms_orders_fulfillment_partition_required_chk,
  DROP CONSTRAINT IF EXISTS wms_orders_fulfillment_partition_key_not_blank_chk,
  DROP COLUMN IF EXISTS fulfillment_partition_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_orders_oms_fulfillment_active
  ON wms.orders (oms_fulfillment_order_id)
  WHERE source = 'oms'
    AND warehouse_status NOT IN ('cancelled', 'voided')
    AND oms_fulfillment_order_id IS NOT NULL;
