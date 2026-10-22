-- Index the exact canonical binding in wmsOmsOrderIdSql. It preserves direct
-- OMS precedence, numeric legacy fallback, channel isolation, and invalid-ID
-- rejection. The account query must not scan every warehouse order per page.
--
-- The migration executor runs this in one transaction with a bounded lock
-- timeout/retry and records success atomically. This is a non-unique read index;
-- it changes no order, operation, inventory, hold, payment, or points record.
-- Cap the entire build at 30 seconds, in addition to the executor's shorter
-- lock-acquisition timeout, so an overloaded release rolls back rather than
-- holding a warehouse write lock indefinitely.
SET LOCAL statement_timeout = '30s';
CREATE INDEX idx_wms_orders_channel_oms_link ON wms.orders (
  channel_id,
  (CASE
    WHEN source = 'oms'
      AND oms_fulfillment_order_id ~ '^[0-9]+$'
      AND length(oms_fulfillment_order_id) <= 18
      THEN oms_fulfillment_order_id::bigint
    WHEN source_table_id ~ '^[0-9]+$'
      AND length(source_table_id) <= 18
      THEN source_table_id::bigint
    ELSE NULL
  END)
);
