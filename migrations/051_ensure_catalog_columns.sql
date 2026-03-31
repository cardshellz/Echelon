-- Migration 051: Ensure catalog columns exist (idempotent backfill)
-- Covers columns from migration 042 that may not have been applied on existing databases.

ALTER TABLE products ADD COLUMN IF NOT EXISTS condition VARCHAR(30) DEFAULT 'new';
ALTER TABLE products ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS harmonized_code VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_specifics JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_type VARCHAR(20) NOT NULL DEFAULT 'inventory';
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_pushed_at TIMESTAMP;
ALTER TABLE products ADD COLUMN IF NOT EXISTS dropship_eligible BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_browse_category_id VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_browse_category_name VARCHAR(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_listing_excluded BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_return_policy_override VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_payment_policy_override VARCHAR(100);

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS gtin VARCHAR(14);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS mpn VARCHAR(100);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS condition_note TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_listing_excluded BOOLEAN DEFAULT FALSE;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override VARCHAR(100);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_return_policy_override VARCHAR(100);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_payment_policy_override VARCHAR(100);

ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS item_specifics JSONB;
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS marketplace_category_id VARCHAR(100);
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS listing_format VARCHAR(30);
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS condition_id INTEGER;
