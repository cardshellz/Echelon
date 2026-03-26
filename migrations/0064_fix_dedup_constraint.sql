-- Drop old constraint that doesn't work
DROP INDEX IF EXISTS unique_shopify_order_id;
DROP INDEX IF EXISTS unique_source_order;

-- Create functional index that normalizes gid:// prefix
-- This catches BOTH formats: gid://shopify/Order/123 AND 123
CREATE UNIQUE INDEX unique_shopify_order_normalized 
ON orders (REPLACE(shopify_order_id, 'gid://shopify/Order/', ''))
WHERE shopify_order_id IS NOT NULL;

-- Also keep the (source, source_table_id) constraint for eBay/TikTok
CREATE UNIQUE INDEX unique_source_order_id 
ON orders (source, source_table_id)
WHERE source_table_id IS NOT NULL;

COMMENT ON INDEX unique_shopify_order_normalized IS 'Prevents duplicate Shopify orders by normalizing gid:// format';
