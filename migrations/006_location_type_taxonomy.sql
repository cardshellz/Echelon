-- Migration 006: Location type taxonomy rename
-- Renames location_type values: forward_pick → pick, bulk_storage → reserve, overflow → reserve
-- Removes bulk_reserve from bin_type: bulk_reserve → pallet
-- Changes column defaults to match new taxonomy

-- 1. Rename location_type values in warehouse_locations
UPDATE warehouse_locations SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE warehouse_locations SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');

-- 2. Rename location_type values in product_locations
UPDATE product_locations SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE product_locations SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');

-- 3. Rename location_type values in warehouse_zones
UPDATE warehouse_zones SET location_type = 'pick' WHERE location_type = 'forward_pick';
UPDATE warehouse_zones SET location_type = 'reserve' WHERE location_type IN ('bulk_storage', 'overflow');

-- 4. Rename bin_type value bulk_reserve → pallet in warehouse_locations
UPDATE warehouse_locations SET bin_type = 'pallet' WHERE bin_type = 'bulk_reserve';

-- 5. Rename replen_source_type in warehouse_locations
UPDATE warehouse_locations SET replen_source_type = 'pick' WHERE replen_source_type = 'forward_pick';
UPDATE warehouse_locations SET replen_source_type = 'reserve' WHERE replen_source_type IN ('bulk_storage', 'overflow');

-- 6. Rename pick_location_type and source_location_type in replen_tier_defaults
UPDATE replen_tier_defaults SET pick_location_type = 'pick' WHERE pick_location_type = 'forward_pick';
UPDATE replen_tier_defaults SET source_location_type = 'reserve' WHERE source_location_type = 'bulk_storage';

-- 7. Rename pick_location_type and source_location_type in replen_rule_overrides
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
