-- 0558_channel_ship_by_date.sql
-- Channel-provided ship-by deadline (eBay shipByDate, Shopify deliver-by, etc.)
-- Feeds the SLA slot of sort_rank so per-order carrier commitments drive
-- pick priority rather than a generic channel-default N-day bucket.
--
-- oms.oms_orders.channel_ship_by_date \u2014 raw value from the platform
-- wms.orders.channel_ship_by_date      \u2014 mirror for sla-monitor consumption
--
-- Idempotent.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS channel_ship_by_date TIMESTAMP;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS channel_ship_by_date TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_oms_orders_channel_ship_by
  ON oms.oms_orders(channel_ship_by_date);
CREATE INDEX IF NOT EXISTS idx_wms_orders_channel_ship_by
  ON wms.orders(channel_ship_by_date);
