-- Migration 021: Add product_variant_id FK to product_locations
--
-- Variants are the assignment unit for bin locations, not products.
-- This adds a proper FK and backfills from existing SKU matches.

BEGIN;

-- 1. Add product_variant_id FK column
ALTER TABLE product_locations
  ADD COLUMN IF NOT EXISTS product_variant_id integer
  REFERENCES product_variants(id) ON DELETE SET NULL;

-- 2. Backfill: match product_locations.sku to product_variants.sku
UPDATE product_locations pl
SET product_variant_id = pv.id
FROM product_variants pv
WHERE UPPER(pl.sku) = UPPER(pv.sku)
  AND pl.product_variant_id IS NULL;

-- 3. Create index for fast lookups by variant
CREATE INDEX IF NOT EXISTS idx_product_locations_variant_id
  ON product_locations(product_variant_id);

COMMIT;
