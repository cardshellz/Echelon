-- Migration 004: Switch inventory_levels from base units to variant units
--
-- All state buckets (reserved, picked, packed, backorder) are converted from
-- base units (pieces) to variant units by dividing by unitsPerVariant.
-- The onHandBase column is dropped entirely since it's redundant with variantQty.
-- Base unit equivalents are now computed at query time: qty * product_variants.units_per_variant

-- Step 1: Convert existing base-unit values to variant-unit values
-- Division is integer (floor) since values should always be exact multiples
UPDATE inventory_levels il
SET
  reserved_base = CASE
    WHEN pv.units_per_variant > 0 THEN il.reserved_base / pv.units_per_variant
    ELSE il.reserved_base
  END,
  picked_base = CASE
    WHEN pv.units_per_variant > 0 THEN il.picked_base / pv.units_per_variant
    ELSE il.picked_base
  END,
  packed_base = CASE
    WHEN pv.units_per_variant > 0 THEN il.packed_base / pv.units_per_variant
    ELSE il.packed_base
  END,
  backorder_base = CASE
    WHEN pv.units_per_variant > 0 THEN il.backorder_base / pv.units_per_variant
    ELSE il.backorder_base
  END
FROM product_variants pv
WHERE il.product_variant_id = pv.id;

-- Step 2: Rename columns from *_base to *_qty
ALTER TABLE inventory_levels RENAME COLUMN reserved_base TO reserved_qty;
ALTER TABLE inventory_levels RENAME COLUMN picked_base TO picked_qty;
ALTER TABLE inventory_levels RENAME COLUMN packed_base TO packed_qty;
ALTER TABLE inventory_levels RENAME COLUMN backorder_base TO backorder_qty;

-- Step 3: Drop the redundant on_hand_base column (variantQty is the source of truth)
ALTER TABLE inventory_levels DROP COLUMN on_hand_base;
