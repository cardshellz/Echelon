-- Pick Zones infrastructure (Step 2 / Option B-lite)
--
-- Creates the warehouse_pick_zones table, adds a nullable pick_zone_id FK to
-- warehouse_locations, and seeds one DEFAULT zone per existing warehouse.
--
-- Also drops the now-obsolete pick_path_optimization column from warehouse_settings
-- (strategy now lives per-zone, see warehouse_pick_zones.strategy).
--
-- This is infrastructure-only. The picker service is unchanged — every pick still
-- flows exactly as it does today. Zones become meaningful once per-location zone
-- assignment + zone-aware pick queue are built in a future PR.

-- ---------------------------------------------------------------------------
-- 1. Create warehouse_pick_zones
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.warehouse_pick_zones (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id         INTEGER NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  code                 VARCHAR(50)  NOT NULL,       -- DEFAULT, EACH, CASE, PALLET, etc.
  name                 VARCHAR(100) NOT NULL,
  priority             INTEGER      NOT NULL DEFAULT 100,
  strategy             VARCHAR(30)  NOT NULL DEFAULT 'zone_sequence'
                         CHECK (strategy IN ('zone_sequence','shortest_path','fifo')),
  uom_hierarchy_min    INTEGER,                     -- NULL = any UOM level
  uom_hierarchy_max    INTEGER,                     -- NULL = any UOM level
  equipment_type       VARCHAR(30)
                         CHECK (equipment_type IS NULL OR equipment_type IN ('cart','forklift','pallet_jack')),
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT warehouse_pick_zones_warehouse_code_unique UNIQUE (warehouse_id, code)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_pick_zones_warehouse_id
  ON inventory.warehouse_pick_zones(warehouse_id);

-- ---------------------------------------------------------------------------
-- 2. Add pick_zone_id to warehouse_locations
-- ---------------------------------------------------------------------------
ALTER TABLE warehouse.warehouse_locations
  ADD COLUMN IF NOT EXISTS pick_zone_id INTEGER;

-- Cross-schema FK constraint (FK from warehouse.warehouse_locations to inventory.warehouse_pick_zones)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_locations_pick_zone_id_fk'
  ) THEN
    ALTER TABLE warehouse.warehouse_locations
      ADD CONSTRAINT warehouse_locations_pick_zone_id_fk
      FOREIGN KEY (pick_zone_id) REFERENCES inventory.warehouse_pick_zones(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_warehouse_locations_pick_zone_id
  ON warehouse.warehouse_locations(pick_zone_id);

-- ---------------------------------------------------------------------------
-- 3. Seed one DEFAULT zone per warehouse
-- ---------------------------------------------------------------------------
-- Idempotent: uses ON CONFLICT on (warehouse_id, code) to skip if already present.
INSERT INTO inventory.warehouse_pick_zones (
  warehouse_id, code, name, priority, strategy, is_active
)
SELECT
  w.id,
  'DEFAULT',
  'Default Pick Zone',
  100,
  'zone_sequence',
  TRUE
FROM warehouse.warehouses w
ON CONFLICT (warehouse_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Drop pick_path_optimization from warehouse_settings
-- ---------------------------------------------------------------------------
-- Strategy now lives on warehouse_pick_zones.strategy.
ALTER TABLE inventory.warehouse_settings
  DROP COLUMN IF EXISTS pick_path_optimization;
