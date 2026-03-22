-- Add source_name to shopify_orders for tracking order origin (web, tiktok, pos, etc.)
-- Used by the Shopify order reconciliation job to tag where orders came from.
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS source_name VARCHAR(100);

-- Index for quick lookups by source
CREATE INDEX IF NOT EXISTS idx_shopify_orders_source_name ON shopify_orders(source_name);
