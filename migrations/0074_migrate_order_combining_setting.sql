-- Migrate the enable_order_combining setting from warehouse.app_settings
-- to warehouse.echelon_settings. Both tables have compatible key/value shape.
--
-- Background: app_settings and echelon_settings have identical schemas and
-- were created as duplicates. app_settings is only used for this single key.
-- We are consolidating on echelon_settings. The app_settings table itself
-- will be dropped in a follow-up migration once all code has stopped reading
-- from it and staging has been verified.

-- Copy the current value over only if:
--   1. There is a row in app_settings for this key, AND
--   2. There is NOT already a row in echelon_settings for this key
--      (so we never overwrite an existing echelon_settings value)
INSERT INTO warehouse.echelon_settings (key, value, type, category, description)
SELECT
  a.key,
  a.value,
  COALESCE(a.type, 'boolean'),
  COALESCE(a.category, 'picking'),
  COALESCE(a.description, 'Show combine badges to pickers for same-customer orders')
FROM warehouse.app_settings a
WHERE a.key = 'enable_order_combining'
  AND NOT EXISTS (
    SELECT 1 FROM warehouse.echelon_settings e
    WHERE e.key = 'enable_order_combining'
  );

-- Verification query (for logs) — count rows after migration
-- Leaves the app_settings row in place so rollback is trivial.
