-- Migration 015: Multi-channel order sync support
-- Adds shop_domain to shopify_orders so orders can be traced back to their source store.
-- Also adds a helper function for resolving channel from shop domain.

-- 1. Add shop_domain to shopify_orders (nullable — legacy orders won't have it)
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shop_domain VARCHAR(255);

-- 2. Backfill existing orders with the primary shop domain from env
-- (Run manually after migration if needed: UPDATE shopify_orders SET shop_domain = 'your-store.myshopify.com' WHERE shop_domain IS NULL)

-- 3. Index for quick channel lookup during order sync
CREATE INDEX IF NOT EXISTS idx_shopify_orders_shop_domain ON shopify_orders(shop_domain);
