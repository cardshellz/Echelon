-- REVERSE of migrations/059_wms_order_items_prices.sql
--
-- Not auto-applied (lives outside migrations/*.sql that run-migrations.ts
-- picks up). Run manually via psql to drop the columns added by 059.

BEGIN;

ALTER TABLE wms.order_items DROP COLUMN IF EXISTS unit_price_cents;
ALTER TABLE wms.order_items DROP COLUMN IF EXISTS paid_price_cents;
ALTER TABLE wms.order_items DROP COLUMN IF EXISTS total_price_cents;

COMMIT;
