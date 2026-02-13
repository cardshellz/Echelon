-- Migration 012: Restructure catalog_products from per-variant to per-product
-- catalog_products becomes 1:1 with products (the unsellable parent),
-- not 1:1 with product_variants (each sellable SKU).
-- Also adds variant-level asset support to catalog_assets.

BEGIN;

-- 1. Add product_id column to catalog_products
ALTER TABLE catalog_products ADD COLUMN product_id INTEGER REFERENCES products(id);

-- 2. Populate product_id from existing product_variant_id → product_variants.product_id
UPDATE catalog_products cp
SET product_id = pv.product_id
FROM product_variants pv
WHERE cp.product_variant_id = pv.id;

-- 3. Build a temp mapping table: for each product_id, pick the lowest catalog_product.id as survivor
CREATE TEMP TABLE cp_migration_map AS
WITH surviving AS (
  SELECT DISTINCT ON (product_id) id as surviving_id, product_id
  FROM catalog_products
  WHERE product_id IS NOT NULL
  ORDER BY product_id, id
)
SELECT cp.id as old_id, s.surviving_id as new_id
FROM catalog_products cp
JOIN surviving s ON cp.product_id = s.product_id
WHERE cp.id != s.surviving_id;

-- 4. Remap all FK references in dependent tables to the surviving catalog_product
UPDATE product_locations SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE order_items SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE picking_logs SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE replen_rules SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE replen_tasks SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE cycle_count_items SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE receiving_lines SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;
UPDATE channel_product_overrides SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;

-- 5. Add variant-level asset support: nullable FK to product_variants
ALTER TABLE catalog_assets ADD COLUMN product_variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE;

-- Carry over the variant association from the about-to-be-deleted catalog_product rows
UPDATE catalog_assets ca
SET product_variant_id = cp.product_variant_id
FROM catalog_products cp
WHERE ca.catalog_product_id = cp.id AND cp.product_variant_id IS NOT NULL;

-- Reassign all catalog_assets to the surviving catalog_product
UPDATE catalog_assets SET catalog_product_id = m.new_id FROM cp_migration_map m WHERE catalog_product_id = m.old_id;

-- 6. Delete duplicate catalog_products (keep only survivors)
DELETE FROM catalog_products WHERE id IN (SELECT old_id FROM cp_migration_map);

-- 7. Add shopify_product_id column, populate from products table
ALTER TABLE catalog_products ADD COLUMN shopify_product_id BIGINT UNIQUE;
UPDATE catalog_products cp
SET shopify_product_id = CAST(p.shopify_product_id AS BIGINT)
FROM products p
WHERE cp.product_id = p.id AND p.shopify_product_id IS NOT NULL;

-- 8. Drop old columns
ALTER TABLE catalog_products DROP COLUMN product_variant_id;
ALTER TABLE catalog_products DROP COLUMN shopify_variant_id;

-- 9. Cleanup
DROP TABLE cp_migration_map;

COMMIT;
