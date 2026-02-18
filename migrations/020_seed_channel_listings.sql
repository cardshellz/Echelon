-- Migration 020: Seed channel_listings from existing Shopify data
--
-- For products with shopify_product_id and variants with shopify_variant_id,
-- create channel_listing records so the push service knows what already exists
-- on Shopify and doesn't create duplicates.

BEGIN;

-- Insert listings for all variants that have Shopify IDs,
-- linked to the default Shopify channel (is_default = 1, provider = 'shopify')
INSERT INTO channel_listings (channel_id, product_variant_id, external_product_id, external_variant_id, external_sku, sync_status, last_synced_at)
SELECT
  c.id AS channel_id,
  pv.id AS product_variant_id,
  p.shopify_product_id AS external_product_id,
  pv.shopify_variant_id AS external_variant_id,
  pv.sku AS external_sku,
  'synced' AS sync_status,
  NOW() AS last_synced_at
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
CROSS JOIN (
  SELECT id FROM channels
  WHERE provider = 'shopify' AND is_default = 1
  LIMIT 1
) c
WHERE p.shopify_product_id IS NOT NULL
  AND pv.shopify_variant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channel_listings cl
    WHERE cl.channel_id = c.id AND cl.product_variant_id = pv.id
  );

COMMIT;
