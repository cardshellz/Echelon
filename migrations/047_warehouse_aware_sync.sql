-- 047: Add warehouse tracking to channel_sync_log for per-warehouse inventory push
-- This supports the warehouse-aware sync that only pushes variants that exist at each warehouse

ALTER TABLE channel_sync_log ADD COLUMN IF NOT EXISTS warehouse_id integer;
ALTER TABLE channel_sync_log ADD COLUMN IF NOT EXISTS shopify_location_id varchar(50);
