-- Migration 042: Catalog Multi-Channel Fields
-- Add fields needed for multi-channel distribution (eBay item specifics, TikTok categories, etc.)

-- Product-level: add structured metadata for channel-specific attributes
ALTER TABLE products ADD COLUMN IF NOT EXISTS condition VARCHAR(30) DEFAULT 'new';
ALTER TABLE products ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS harmonized_code VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_specifics JSONB; -- eBay item specifics, TikTok attributes, etc.

-- Variant-level: add GTIN/MPN for marketplace requirements
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS gtin VARCHAR(14); -- UPC/EAN/ISBN (eBay requires)
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS mpn VARCHAR(100); -- Manufacturer Part Number
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS condition_note TEXT; -- Per-variant condition details

-- Channel product overrides: add marketplace-specific structured fields
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS item_specifics JSONB; -- eBay item specifics overrides
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS marketplace_category_id VARCHAR(100); -- e.g., eBay category ID
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS listing_format VARCHAR(30); -- eBay: auction/fixed_price/both
ALTER TABLE channel_product_overrides ADD COLUMN IF NOT EXISTS condition_id INTEGER; -- eBay condition ID (1000=New, etc.)

-- Allocation audit log for tracking allocation engine decisions
CREATE TABLE IF NOT EXISTS allocation_audit_log (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id INTEGER REFERENCES products(id),
  product_variant_id INTEGER REFERENCES product_variants(id),
  channel_id INTEGER REFERENCES channels(id),
  total_atp_base INTEGER NOT NULL,
  allocated_qty INTEGER NOT NULL,
  previous_qty INTEGER,
  allocation_method VARCHAR(30) NOT NULL, -- 'priority', 'percentage', 'fixed', 'override'
  details JSONB, -- Full breakdown of allocation decision
  triggered_by VARCHAR(30), -- 'inventory_change', 'config_change', 'manual', 'scheduled'
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS allocation_audit_log_product_idx ON allocation_audit_log(product_id);
CREATE INDEX IF NOT EXISTS allocation_audit_log_channel_idx ON allocation_audit_log(channel_id);
CREATE INDEX IF NOT EXISTS allocation_audit_log_created_idx ON allocation_audit_log(created_at);
