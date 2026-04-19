-- Migration 025: Enforce SKU uniqueness on active product_variants
--
-- Problem: product_variants.sku has no uniqueness constraint, allowing silent duplicates.
-- All SKU lookups (reservation, picking, cycle count, receiving) use getProductVariantBySku()
-- which returns only the first match — the "other" variant is invisible to fulfillment.
--
-- Fix: Add a partial unique index on UPPER(sku) WHERE is_active = true AND sku IS NOT NULL.
-- First deactivate any existing duplicates (keep the one with inventory or the older one).

-- Step 1: Find and deactivate duplicate active SKUs (keep the one with more inventory, or older if tied)
DO $$
DECLARE
  dup RECORD;
  keeper_id INT;
  victim_id INT;
BEGIN
  -- For each group of active variants sharing the same SKU (case-insensitive),
  -- keep the one with the most inventory (sum of variant_qty across locations).
  -- If tied, keep the older one (lower id).
  FOR dup IN
    SELECT UPPER(sku) AS upper_sku, array_agg(id ORDER BY id) AS variant_ids
    FROM product_variants
    WHERE is_active = true AND sku IS NOT NULL
    GROUP BY UPPER(sku)
    HAVING COUNT(*) > 1
  LOOP
    -- Pick keeper: variant with most total inventory, tie-break by lowest id
    SELECT pv.id INTO keeper_id
    FROM product_variants pv
    LEFT JOIN (
      SELECT product_variant_id, COALESCE(SUM(variant_qty), 0) AS total_qty
      FROM inventory_levels
      GROUP BY product_variant_id
    ) il ON il.product_variant_id = pv.id
    WHERE pv.id = ANY(dup.variant_ids)
    ORDER BY COALESCE(il.total_qty, 0) DESC, pv.id ASC
    LIMIT 1;

    -- Deactivate all others
    UPDATE product_variants
    SET is_active = false, updated_at = NOW()
    WHERE id = ANY(dup.variant_ids) AND id != keeper_id;

    RAISE NOTICE 'SKU % — kept variant_id=%, deactivated: %',
      dup.upper_sku, keeper_id,
      array_remove(dup.variant_ids, keeper_id);
  END LOOP;
END $$;

-- Step 2: Create partial unique index on active variant SKUs (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku_active_unique
  ON product_variants (UPPER(sku))
  WHERE is_active = true AND sku IS NOT NULL;
