-- Phase 6 OMS/WMS fulfillment partitions.
--
-- Current production behavior remains one active WMS order per OMS order.
-- The explicit partition key makes that invariant future-safe: split routing
-- can add non-overlapping partition keys later, while duplicate full WMS rows
-- in the default partition stay blocked at the database boundary.

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS fulfillment_partition_key varchar(120);

UPDATE wms.orders
SET fulfillment_partition_key = 'default'
WHERE fulfillment_partition_key IS NULL
   OR BTRIM(fulfillment_partition_key) = '';

ALTER TABLE wms.orders
  ALTER COLUMN fulfillment_partition_key SET DEFAULT 'default',
  ALTER COLUMN fulfillment_partition_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wms_orders_fulfillment_partition_key_not_blank_chk'
  ) THEN
    ALTER TABLE wms.orders
      ADD CONSTRAINT wms_orders_fulfillment_partition_key_not_blank_chk
      CHECK (BTRIM(fulfillment_partition_key) <> '');
  END IF;
END $$;

DROP INDEX IF EXISTS wms.uq_wms_orders_oms_fulfillment_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_orders_oms_fulfillment_partition_active
  ON wms.orders (
    source,
    oms_fulfillment_order_id,
    (COALESCE(warehouse_id, 0)),
    fulfillment_partition_key
  )
  WHERE source = 'oms'
    AND warehouse_status NOT IN ('cancelled', 'voided')
    AND oms_fulfillment_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wms_orders_oms_fulfillment_partition
  ON wms.orders (
    oms_fulfillment_order_id,
    (COALESCE(warehouse_id, 0)),
    fulfillment_partition_key
  )
  WHERE source = 'oms'
    AND oms_fulfillment_order_id IS NOT NULL;
