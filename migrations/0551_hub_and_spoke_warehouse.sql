-- Migration: 055_hub_and_spoke_warehouse.sql
-- Adds hub-and-spoke support to the warehouses table.
-- A spoke warehouse (bulk_storage type) links to a hub operations warehouse.
-- The hub's ATP pool is computed across all its spoke inventories + its own.

-- Step 1: Add the hub_warehouse_id column (self-referencing FK, nullable)
ALTER TABLE warehouse.warehouses
  ADD COLUMN IF NOT EXISTS hub_warehouse_id INTEGER
    REFERENCES warehouse.warehouses(id)
    ON DELETE SET NULL;

-- Step 2: Add a check constraint — a warehouse cannot be its own hub
ALTER TABLE warehouse.warehouses
  DROP CONSTRAINT IF EXISTS chk_warehouse_not_own_hub;
ALTER TABLE warehouse.warehouses
  ADD CONSTRAINT chk_warehouse_not_own_hub
    CHECK (hub_warehouse_id IS NULL OR hub_warehouse_id <> id);

-- Step 3: Add an index to speed up spoke lookups from the hub
CREATE INDEX IF NOT EXISTS idx_warehouses_hub_warehouse_id
  ON warehouse.warehouses(hub_warehouse_id)
  WHERE hub_warehouse_id IS NOT NULL;

-- NOTE: Set Route 19's hub AFTER confirming warehouse IDs via:
--   SELECT id, code, name FROM warehouse.warehouses ORDER BY id;
-- Then run:
--   UPDATE warehouse.warehouses SET hub_warehouse_id = <LEON_ID> WHERE code = 'RT19';
