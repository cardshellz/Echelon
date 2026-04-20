-- Remove phantom / duplicate keys from warehouse.echelon_settings.
--
-- These keys were accepted by the /api/settings endpoint and surfaced in
-- the admin UI, but nothing in the server actually read them. The real
-- storage for picking_batch_size and auto_release_delay_minutes is on
-- inventory.warehouse_settings (per-warehouse columns), managed via
-- PickingSettings.tsx.
--
-- Safe to delete: no code reads these keys. If admins manually wrote
-- values via the old UI, the values were never consumed.

DELETE FROM warehouse.echelon_settings
WHERE key IN (
  'picking_batch_size',
  'auto_release_delay_minutes'
);
