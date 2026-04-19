-- Order combining per-warehouse scope + settings consolidation.
--
-- Orders from different warehouses cannot combine (no transship at pick time).
-- This migration:
--   1. Adds warehouse_id to wms.combined_order_groups so each group is scoped
--   2. Backfills warehouse_id on existing groups from the group's orders
--   3. Copies echelon_settings.enable_order_combining into the DEFAULT row of
--      inventory.warehouse_settings (preserving any existing admin toggle)
--   4. Deletes the echelon_settings key (now lives on warehouse_settings)

-- -----------------------------------------------------------------------------
-- 1. Add warehouse_id column to combined_order_groups
-- -----------------------------------------------------------------------------
ALTER TABLE wms.combined_order_groups
  ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'combined_order_groups_warehouse_id_fk'
  ) THEN
    ALTER TABLE wms.combined_order_groups
      ADD CONSTRAINT combined_order_groups_warehouse_id_fk
      FOREIGN KEY (warehouse_id) REFERENCES warehouse.warehouses(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combined_order_groups_warehouse_id
  ON wms.combined_order_groups(warehouse_id);

-- -----------------------------------------------------------------------------
-- 2. Backfill warehouse_id on existing groups
-- -----------------------------------------------------------------------------
-- Use the warehouse_id of any order in the group (they should all match; we
-- pick MIN to be deterministic).
UPDATE wms.combined_order_groups cog
SET warehouse_id = sub.warehouse_id
FROM (
  SELECT o.combined_group_id AS group_id,
         MIN(o.warehouse_id) AS warehouse_id
  FROM wms.orders o
  WHERE o.combined_group_id IS NOT NULL
    AND o.warehouse_id IS NOT NULL
  GROUP BY o.combined_group_id
) sub
WHERE cog.id = sub.group_id
  AND cog.warehouse_id IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Copy echelon_settings.enable_order_combining to warehouse_settings DEFAULT
-- -----------------------------------------------------------------------------
-- Only if an existing global value exists AND the DEFAULT row is present.
-- This preserves any manual toggle that was made via the old global endpoint.
UPDATE inventory.warehouse_settings ws
SET enable_order_combining = CASE
    WHEN LOWER(COALESCE(es.value, 'true')) IN ('true','1','yes','on') THEN 1
    ELSE 0
  END,
  updated_at = NOW()
FROM warehouse.echelon_settings es
WHERE es.key = 'enable_order_combining'
  AND ws.warehouse_code = 'DEFAULT';

-- -----------------------------------------------------------------------------
-- 4. Delete the echelon_settings key \u2014 it's now redundant
-- -----------------------------------------------------------------------------
DELETE FROM warehouse.echelon_settings WHERE key = 'enable_order_combining';
