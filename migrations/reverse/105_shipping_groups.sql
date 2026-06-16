-- Reverse migration: 105_shipping_groups
-- Reverses migrations/105_shipping_groups.sql.
--
-- !!! DATA-LOSS WARNING !!!
--   Dropping catalog.products.shipping_group_id loses every product's shipping
--   group assignment (the storage_boxes/protection backfill + any admin edits).
--   Dropping catalog.shipping_groups removes the group registry itself.
--
--   - SAFE at this phase: no storefront/sync code reads the column yet, so the
--     assignment is reconstructable by re-running migration 105's backfill.
--   - The FK is ON DELETE SET NULL. Dropping the column drops its FK implicitly,
--     but we drop the constraint by its explicit name first for clarity, then the
--     column, then the table (CASCADE as a failsafe).
--
-- Idempotent: DROP CONSTRAINT / DROP COLUMN / DROP TABLE use IF EXISTS.

ALTER TABLE catalog.products
  DROP CONSTRAINT IF EXISTS products_shipping_group_id_shipping_groups_id_fk;

ALTER TABLE catalog.products DROP COLUMN IF EXISTS shipping_group_id;

DROP TABLE IF EXISTS catalog.shipping_groups CASCADE;
