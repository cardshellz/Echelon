-- Migration 022: Drop location_type from product_locations
--
-- product_locations.location_type was a stale denormalized copy of
-- warehouse_locations.location_type that drifted out of sync (195 of 207
-- rows had 'forward_pick' instead of 'pick' after migration 006).
--
-- All logic now JOINs to warehouse_locations for location_type and uses
-- warehouse_locations.is_pickable as the authoritative flag for pick eligibility.
--
-- This column is no longer read or written by any code path.

BEGIN;

ALTER TABLE product_locations DROP COLUMN IF EXISTS location_type;

COMMIT;
