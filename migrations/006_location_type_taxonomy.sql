-- Migration 006: Location type taxonomy fix
-- Fixes warehouse_locations where bin_type values were loaded into location_type column
-- Also handles legacy renames (forward_pick → pick, bulk_storage → reserve, overflow → reserve)

-- 1. Fix warehouse_locations: bin_type values in location_type column
--    bin (108 rows)    → location_type='pick',    bin_type='bin'
--    pallet (85 rows)  → location_type='pick',    bin_type='pallet'  (floor-level pick pallets)
--    bulk_reserve (36)  → location_type='reserve', bin_type='pallet'  (reserve pallets)
UPDATE warehouse_locations SET location_type = 'pick',    bin_type = 'bin'    WHERE location_type = 'bin';
UPDATE warehouse_locations SET location_type = 'pick',    bin_type = 'pallet' WHERE location_type = 'pallet';
UPDATE warehouse_locations SET location_type = 'reserve', bin_type = 'pallet' WHERE location_type = 'bulk_reserve';

-- 2. Legacy renames (in case any old values exist)
UPDATE warehouse_locations SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE warehouse_locations SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');
UPDATE warehouse_locations SET bin_type = 'pallet' WHERE bin_type = 'bulk_reserve';

-- 3. Fix product_locations
UPDATE product_locations SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE product_locations SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');

-- 4. Fix warehouse_zones
UPDATE warehouse_zones SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE warehouse_zones SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');

-- 5. Fix replen_source_type in warehouse_locations
UPDATE warehouse_locations SET replen_source_type = 'pick' WHERE replen_source_type = 'forward_pick';
UPDATE warehouse_locations SET replen_source_type = 'reserve' WHERE replen_source_type IN ('bulk_storage', 'overflow');

-- 6. Fix replen_tier_defaults
UPDATE replen_tier_defaults SET pick_location_type = 'pick' WHERE pick_location_type = 'forward_pick';
UPDATE replen_tier_defaults SET source_location_type = 'reserve' WHERE source_location_type = 'bulk_storage';

-- 7. Fix replen_rule_overrides
UPDATE replen_rule_overrides SET pick_location_type = 'pick' WHERE pick_location_type = 'forward_pick';
UPDATE replen_rule_overrides SET source_location_type = 'reserve' WHERE source_location_type = 'bulk_storage';

-- 8. Update column defaults
ALTER TABLE warehouse_locations ALTER COLUMN location_type SET DEFAULT 'pick';
ALTER TABLE product_locations ALTER COLUMN location_type SET DEFAULT 'pick';
ALTER TABLE warehouse_zones ALTER COLUMN location_type SET DEFAULT 'pick';
ALTER TABLE replen_tier_defaults ALTER COLUMN pick_location_type SET DEFAULT 'pick';
ALTER TABLE replen_tier_defaults ALTER COLUMN source_location_type SET DEFAULT 'reserve';
ALTER TABLE replen_rule_overrides ALTER COLUMN pick_location_type SET DEFAULT 'pick';
ALTER TABLE replen_rule_overrides ALTER COLUMN source_location_type SET DEFAULT 'reserve';
