-- Migrate the enable_order_combining setting from warehouse.app_settings
-- to warehouse.echelon_settings. Both tables have compatible key/value shape.
--
-- Non-destructive: copies the row only if echelon_settings doesn't already
-- have the key. app_settings row stays in place for rollback safety.

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
