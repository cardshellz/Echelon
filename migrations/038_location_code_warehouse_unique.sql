-- Make location code unique per warehouse instead of globally unique
-- This allows FLOOR-01 to exist in multiple warehouses

-- Drop the global unique constraint on code (may exist under either name depending on how it was created)
ALTER TABLE warehouse_locations DROP CONSTRAINT IF EXISTS warehouse_locations_code_unique;
ALTER TABLE warehouse_locations DROP CONSTRAINT IF EXISTS warehouse_locations_code_key;

-- Add composite unique constraint on (code, warehouse_id)
ALTER TABLE warehouse_locations ADD CONSTRAINT warehouse_locations_code_warehouse_unique UNIQUE (code, warehouse_id);
