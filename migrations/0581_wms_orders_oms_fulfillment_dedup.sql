-- Migration 0581: Unique index on wms.orders(oms_fulfillment_order_id) for active orders
--
-- Prevents duplicate WMS orders for the same OMS fulfillment order.
-- The advisory lock in syncOmsOrderToWms is the runtime guard; this index
-- is the permanent DB-level backstop.
--
-- Excludes cancelled/voided rows so that historical duplicates (all known
-- dupes are {shipped, cancelled} pairs) do not block index creation.

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_orders_oms_fulfillment_active
  ON wms.orders (oms_fulfillment_order_id)
  WHERE source = 'oms'
    AND warehouse_status NOT IN ('cancelled', 'voided')
    AND oms_fulfillment_order_id IS NOT NULL;
