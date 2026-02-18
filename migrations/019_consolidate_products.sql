-- Migration 019: Consolidate catalog_products into products
--
-- Merges catalog_products (1:1 with products since migration 012) directly into
-- the products table. Renames catalog_assets → product_assets. Drops imageUrl
-- columns from products and product_variants (product_assets is now the single
-- source of truth for images). Remaps all catalog_product_id FK references to
-- point directly to products.id.

BEGIN;

-- ============================================================
-- 1. Add content columns to products + fix column types
-- ============================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS title varchar(500);
ALTER TABLE products ADD COLUMN IF NOT EXISTS bullet_points jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory varchar(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer varchar(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_title varchar(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'active';
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_pushed_at timestamp;

-- Convert products.tags from text[] to jsonb (Drizzle schema expects jsonb)
ALTER TABLE products ALTER COLUMN tags TYPE jsonb USING to_jsonb(tags);

-- ============================================================
-- 2. Copy content from catalog_products → products
-- ============================================================
UPDATE products p
SET
  title = cp.title,
  description = COALESCE(cp.description, p.description),
  bullet_points = cp.bullet_points,
  category = COALESCE(cp.category, p.category),
  subcategory = cp.subcategory,
  brand = COALESCE(cp.brand, p.brand),
  manufacturer = cp.manufacturer,
  tags = cp.tags,
  seo_title = cp.seo_title,
  seo_description = cp.seo_description,
  status = COALESCE(cp.status, 'active')
FROM catalog_products cp
WHERE cp.product_id = p.id;

-- ============================================================
-- 3. Rename catalog_assets → product_assets, remap FK
-- ============================================================
ALTER TABLE catalog_assets RENAME TO product_assets;

-- Drop old FK constraint BEFORE renaming column (actual constraint name from DB)
ALTER TABLE product_assets DROP CONSTRAINT IF EXISTS catalog_assets_catalog_product_id_fkey;
ALTER TABLE product_assets DROP CONSTRAINT IF EXISTS catalog_assets_catalog_product_id_catalog_products_id_fk;

ALTER TABLE product_assets RENAME COLUMN catalog_product_id TO product_id;

-- Delete assets for orphaned catalog_products (NULL product_id)
DELETE FROM product_assets pa
USING catalog_products cp
WHERE pa.product_id = cp.id AND cp.product_id IS NULL;

-- Remap product_id values: catalog_products.id → products.id
UPDATE product_assets pa
SET product_id = cp.product_id
FROM catalog_products cp
WHERE pa.product_id = cp.id AND cp.product_id IS NOT NULL;

-- Add new FK to products
ALTER TABLE product_assets ADD CONSTRAINT product_assets_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;

-- ============================================================
-- 4. Migrate imageUrl data into product_assets
-- ============================================================

-- Product hero images
INSERT INTO product_assets (product_id, product_variant_id, asset_type, url, is_primary, position)
SELECT p.id, NULL, 'image', p.image_url, 1, 0
FROM products p
WHERE p.image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_assets pa
    WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1
  );

-- Variant images
INSERT INTO product_assets (product_id, product_variant_id, asset_type, url, is_primary, position)
SELECT pv.product_id, pv.id, 'image', pv.image_url, 1, 0
FROM product_variants pv
WHERE pv.image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_assets pa
    WHERE pa.product_variant_id = pv.id AND pa.is_primary = 1
  );

-- Drop imageUrl columns (single source of truth = product_assets)
ALTER TABLE products DROP COLUMN IF EXISTS image_url;
ALTER TABLE product_variants DROP COLUMN IF EXISTS image_url;

-- ============================================================
-- 5. Drop FK constraints referencing catalog_products
-- ============================================================
ALTER TABLE channel_product_overrides DROP CONSTRAINT IF EXISTS channel_product_overrides_catalog_product_id_fkey;
ALTER TABLE channel_product_overrides DROP CONSTRAINT IF EXISTS channel_product_overrides_catalog_product_id_catalog_products_id_fk;
ALTER TABLE replen_rules DROP CONSTRAINT IF EXISTS replen_rules_catalog_product_id_fkey;
ALTER TABLE replen_rules DROP CONSTRAINT IF EXISTS replen_rules_catalog_product_id_catalog_products_id_fk;
ALTER TABLE replen_tasks DROP CONSTRAINT IF EXISTS replen_tasks_catalog_product_id_fkey;
ALTER TABLE replen_tasks DROP CONSTRAINT IF EXISTS replen_tasks_catalog_product_id_catalog_products_id_fk;
ALTER TABLE cycle_count_items DROP CONSTRAINT IF EXISTS cycle_count_items_catalog_product_id_fkey;
ALTER TABLE cycle_count_items DROP CONSTRAINT IF EXISTS cycle_count_items_catalog_product_id_catalog_products_id_fk;
ALTER TABLE receiving_lines DROP CONSTRAINT IF EXISTS receiving_lines_catalog_product_id_fkey;
ALTER TABLE receiving_lines DROP CONSTRAINT IF EXISTS receiving_lines_catalog_product_id_catalog_products_id_fk;

-- ============================================================
-- 6. Rename columns + remap values for all dependent tables
-- ============================================================

-- channel_product_overrides (NOT NULL — delete orphans first)
DELETE FROM channel_product_overrides cpo
USING catalog_products cp
WHERE cpo.catalog_product_id = cp.id AND cp.product_id IS NULL;

ALTER TABLE channel_product_overrides RENAME COLUMN catalog_product_id TO product_id;
UPDATE channel_product_overrides cpo
SET product_id = cp.product_id
FROM catalog_products cp
WHERE cpo.product_id = cp.id AND cp.product_id IS NOT NULL;

-- product_locations (nullable, no FK constraint)
ALTER TABLE product_locations RENAME COLUMN catalog_product_id TO product_id;
UPDATE product_locations pl
SET product_id = cp.product_id
FROM catalog_products cp
WHERE pl.product_id = cp.id AND cp.product_id IS NOT NULL;

-- replen_rules
ALTER TABLE replen_rules RENAME COLUMN catalog_product_id TO product_id;
UPDATE replen_rules rr
SET product_id = cp.product_id
FROM catalog_products cp
WHERE rr.product_id = cp.id AND cp.product_id IS NOT NULL;

-- replen_tasks
ALTER TABLE replen_tasks RENAME COLUMN catalog_product_id TO product_id;
UPDATE replen_tasks rt
SET product_id = cp.product_id
FROM catalog_products cp
WHERE rt.product_id = cp.id AND cp.product_id IS NOT NULL;

-- cycle_count_items
ALTER TABLE cycle_count_items RENAME COLUMN catalog_product_id TO product_id;
UPDATE cycle_count_items cci
SET product_id = cp.product_id
FROM catalog_products cp
WHERE cci.product_id = cp.id AND cp.product_id IS NOT NULL;

-- receiving_lines
ALTER TABLE receiving_lines RENAME COLUMN catalog_product_id TO product_id;
UPDATE receiving_lines rl
SET product_id = cp.product_id
FROM catalog_products cp
WHERE rl.product_id = cp.id AND cp.product_id IS NOT NULL;

-- order_items (nullable, no FK constraint)
ALTER TABLE order_items RENAME COLUMN catalog_product_id TO product_id;
UPDATE order_items oi
SET product_id = cp.product_id
FROM catalog_products cp
WHERE oi.product_id = cp.id AND cp.product_id IS NOT NULL;

-- picking_logs (nullable, no FK constraint)
ALTER TABLE picking_logs RENAME COLUMN catalog_product_id TO product_id;
UPDATE picking_logs plg
SET product_id = cp.product_id
FROM catalog_products cp
WHERE plg.product_id = cp.id AND cp.product_id IS NOT NULL;

-- channel_asset_overrides: rename catalog_asset_id → product_asset_id
ALTER TABLE channel_asset_overrides DROP CONSTRAINT IF EXISTS channel_asset_overrides_catalog_asset_id_fkey;
ALTER TABLE channel_asset_overrides DROP CONSTRAINT IF EXISTS channel_asset_overrides_catalog_asset_id_catalog_assets_id_fk;
ALTER TABLE channel_asset_overrides RENAME COLUMN catalog_asset_id TO product_asset_id;
ALTER TABLE channel_asset_overrides ADD CONSTRAINT channel_asset_overrides_product_asset_id_product_assets_id_fk
  FOREIGN KEY (product_asset_id) REFERENCES product_assets(id) ON DELETE CASCADE;

-- ============================================================
-- 7. Clean up orphaned rows then add FK constraints
-- ============================================================

-- NULL out product_id for rows that still point to old catalog_products IDs
-- (these came from orphaned catalog_products with no product_id)
UPDATE product_locations SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE replen_rules SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE replen_tasks SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE cycle_count_items SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE receiving_lines SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE order_items SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);
UPDATE picking_logs SET product_id = NULL
  WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products);

-- Delete orphaned channel_product_overrides (product_id is NOT NULL column)
DELETE FROM channel_product_overrides
  WHERE product_id NOT IN (SELECT id FROM products);

-- Add FK constraints
ALTER TABLE channel_product_overrides ADD CONSTRAINT channel_product_overrides_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE replen_rules ADD CONSTRAINT replen_rules_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE replen_tasks ADD CONSTRAINT replen_tasks_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE cycle_count_items ADD CONSTRAINT cycle_count_items_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE receiving_lines ADD CONSTRAINT receiving_lines_product_id_products_id_fk
  FOREIGN KEY (product_id) REFERENCES products(id);

-- ============================================================
-- 8. Drop catalog_products table
-- ============================================================
DROP TABLE catalog_products;

COMMIT;
