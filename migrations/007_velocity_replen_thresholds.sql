-- Migration 007: Velocity-based pallet drop thresholds + per-location replen config
-- Renames min_qty → trigger_value (contextual: units for bins, coverage days for pallets)
-- Adds velocity_lookback_days to warehouse_settings
-- Creates location_replen_config table for per-location overrides

-- 1. Rename min_qty → trigger_value
ALTER TABLE replen_tier_defaults RENAME COLUMN min_qty TO trigger_value;
ALTER TABLE replen_rules RENAME COLUMN min_qty TO trigger_value;

-- 2. Velocity lookback setting
ALTER TABLE warehouse_settings ADD COLUMN velocity_lookback_days integer NOT NULL DEFAULT 14;

-- 3. Per-location replen config
CREATE TABLE location_replen_config (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  warehouse_location_id integer NOT NULL REFERENCES warehouse_locations(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES product_variants(id) ON DELETE CASCADE,
  trigger_value numeric(8,2),
  max_qty integer,
  replen_method varchar(30),
  is_active integer NOT NULL DEFAULT 1,
  notes text,
  created_at timestamp DEFAULT NOW() NOT NULL,
  updated_at timestamp DEFAULT NOW() NOT NULL,
  UNIQUE(warehouse_location_id, product_variant_id)
);

CREATE INDEX idx_lrc_location ON location_replen_config(warehouse_location_id);
CREATE INDEX idx_lrc_variant ON location_replen_config(product_variant_id) WHERE product_variant_id IS NOT NULL;

-- 4. Performance index for velocity calculation
CREATE INDEX idx_txn_velocity ON inventory_transactions(product_variant_id, transaction_type, created_at)
  WHERE transaction_type = 'pick';
