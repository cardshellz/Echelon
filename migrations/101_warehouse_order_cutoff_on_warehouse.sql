-- Migration 101: Move the SLA order cutoff onto the warehouse
--
-- The cutoff + timezone are a pair that describe a single building's fulfillment
-- clock (when its carrier truck leaves), so they belong together on the
-- warehouse — which already carries `timezone`. Migration 100 had temporarily
-- parked the cutoff (and a duplicate timezone) on inventory.warehouse_settings;
-- this moves the cutoff to warehouse.warehouses next to the existing timezone.
--
-- The warehouse_settings.order_cutoff_local / .timezone columns from migration
-- 100 are now dead and no longer read by the code. They are intentionally left
-- in place here to keep the rolling deploy safe (old dynos still SELECT them);
-- a follow-up cleanup migration can drop them once fully rolled out.

ALTER TABLE warehouse.warehouses
  ADD COLUMN IF NOT EXISTS order_cutoff_local varchar(5);

-- Backfill each warehouse's cutoff from its warehouse_settings row (LEON = 14:00).
UPDATE warehouse.warehouses w
SET order_cutoff_local = ws.order_cutoff_local
FROM inventory.warehouse_settings ws
WHERE ws.warehouse_id = w.id
  AND ws.order_cutoff_local IS NOT NULL
  AND w.order_cutoff_local IS NULL;

-- Default warehouse: if it didn't have its own settings row, inherit the
-- DEFAULT-row cutoff so unassigned orders keep bucketing the same way they do
-- today (getSlaCutoffConfig falls back to the default warehouse for null).
UPDATE warehouse.warehouses w
SET order_cutoff_local = (
  SELECT order_cutoff_local FROM inventory.warehouse_settings
  WHERE warehouse_code = 'DEFAULT' LIMIT 1
)
WHERE w.is_default = 1
  AND w.order_cutoff_local IS NULL;
