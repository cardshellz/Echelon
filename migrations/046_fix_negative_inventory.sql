-- Migration 046: Fix negative inventory records caused by Cycle Count #34
-- Root cause: stale variance applied with allowNegative:true days after count
-- See NEGATIVE-INVENTORY-INVESTIGATION.md for full analysis

-- 1. ARM-ENV-DBL-C300 (variant 63) @ H-05-A (location 1264): -2 → 0
UPDATE inventory_levels 
SET variant_qty = 0, updated_at = NOW()
WHERE product_variant_id = 63 
  AND warehouse_location_id = 1264 
  AND variant_qty < 0;

INSERT INTO inventory_transactions (
  product_variant_id, to_location_id, transaction_type,
  variant_qty_delta, variant_qty_before, variant_qty_after,
  source_state, target_state, reference_type, reference_id,
  notes, created_at
) SELECT 
  63, 1264, 'adjustment',
  ABS(il.variant_qty), il.variant_qty, 0,
  'on_hand', 'on_hand', 'correction', 'negative-inventory-fix-046',
  'Correction: zeroing negative inventory caused by cycle count #34 stale variance. See migration 046.',
  NOW()
FROM inventory_levels il
WHERE il.product_variant_id = 63 
  AND il.warehouse_location_id = 1264 
  AND il.variant_qty < 0;

-- Release orphaned reservation at H-05-A for variant 63
UPDATE inventory_levels 
SET reserved_qty = 0, updated_at = NOW()
WHERE product_variant_id = 63 
  AND warehouse_location_id = 1264 
  AND reserved_qty > 0
  AND variant_qty <= 0;

-- 2. ARM-ENV-SGL-NM-C500 (variant 69) @ H-04-A (location 1262): -9 → 0
UPDATE inventory_levels 
SET variant_qty = 0, updated_at = NOW()
WHERE product_variant_id = 69 
  AND warehouse_location_id = 1262 
  AND variant_qty < 0;

INSERT INTO inventory_transactions (
  product_variant_id, to_location_id, transaction_type,
  variant_qty_delta, variant_qty_before, variant_qty_after,
  source_state, target_state, reference_type, reference_id,
  notes, created_at
) SELECT 
  69, 1262, 'adjustment',
  ABS(il.variant_qty), il.variant_qty, 0,
  'on_hand', 'on_hand', 'correction', 'negative-inventory-fix-046',
  'Correction: zeroing negative inventory caused by cycle count #34 stale variance. Releasing 3 orphaned reserved units. See migration 046.',
  NOW()
FROM inventory_levels il
WHERE il.product_variant_id = 69 
  AND il.warehouse_location_id = 1262 
  AND il.variant_qty < 0;

-- Release orphaned reservations at H-04-A for variant 69
UPDATE inventory_levels 
SET reserved_qty = 0, updated_at = NOW()
WHERE product_variant_id = 69 
  AND warehouse_location_id = 1262 
  AND reserved_qty > 0
  AND variant_qty <= 0;

-- 3. ARM-ENV-SGL-C700 (variant 67) @ H-12 (location 1272): -2 → 0
UPDATE inventory_levels 
SET variant_qty = 0, updated_at = NOW()
WHERE product_variant_id = 67 
  AND warehouse_location_id = 1272 
  AND variant_qty < 0;

INSERT INTO inventory_transactions (
  product_variant_id, to_location_id, transaction_type,
  variant_qty_delta, variant_qty_before, variant_qty_after,
  source_state, target_state, reference_type, reference_id,
  notes, created_at
) SELECT 
  67, 1272, 'adjustment',
  ABS(il.variant_qty), il.variant_qty, 0,
  'on_hand', 'on_hand', 'correction', 'negative-inventory-fix-046',
  'Correction: zeroing negative inventory caused by cycle count #34 stale variance. See migration 046.',
  NOW()
FROM inventory_levels il
WHERE il.product_variant_id = 67 
  AND il.warehouse_location_id = 1272 
  AND il.variant_qty < 0;
