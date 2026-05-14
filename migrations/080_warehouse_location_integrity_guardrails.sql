-- Guard new warehouse location writes without requiring historical cleanup in
-- the same deploy. NOT VALID skips existing rows but still enforces future
-- inserts/updates.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_locations_active_operational_has_warehouse_chk'
      AND conrelid = 'warehouse.warehouse_locations'::regclass
  ) THEN
    ALTER TABLE warehouse.warehouse_locations
      ADD CONSTRAINT warehouse_locations_active_operational_has_warehouse_chk
      CHECK (
        is_active <> 1
        OR location_type NOT IN ('pick', 'reserve', 'receiving', 'staging')
        OR warehouse_id IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_locations_pickable_type_consistent_chk'
      AND conrelid = 'warehouse.warehouse_locations'::regclass
  ) THEN
    ALTER TABLE warehouse.warehouse_locations
      ADD CONSTRAINT warehouse_locations_pickable_type_consistent_chk
      CHECK (
        is_active <> 1
        OR is_pickable <> 1
        OR location_type = 'pick'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_locations_pick_type_pickable_chk'
      AND conrelid = 'warehouse.warehouse_locations'::regclass
  ) THEN
    ALTER TABLE warehouse.warehouse_locations
      ADD CONSTRAINT warehouse_locations_pick_type_pickable_chk
      CHECK (
        is_active <> 1
        OR location_type <> 'pick'
        OR is_pickable = 1
      ) NOT VALID;
  END IF;
END $$;
