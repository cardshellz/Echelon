-- Make eBay listing intent channel-native.
--
-- Legacy eBay exclusion booleans are retained for backwards compatibility, but
-- channel_product_overrides / channel_variant_overrides are now the allocation
-- source of truth. This backfills existing eBay exclusions into those tables.

INSERT INTO channels.channel_product_overrides (
  channel_id,
  product_id,
  is_listed,
  created_at,
  updated_at
)
SELECT
  67,
  p.id,
  0,
  NOW(),
  NOW()
FROM catalog.products p
WHERE COALESCE(p.ebay_listing_excluded, false) = true
ON CONFLICT (channel_id, product_id)
DO UPDATE SET
  is_listed = 0,
  updated_at = NOW();

INSERT INTO channels.channel_variant_overrides (
  channel_id,
  product_variant_id,
  is_listed,
  created_at,
  updated_at
)
SELECT
  67,
  pv.id,
  0,
  NOW(),
  NOW()
FROM catalog.product_variants pv
WHERE COALESCE(pv.ebay_listing_excluded, false) = true
ON CONFLICT (channel_id, product_variant_id)
DO UPDATE SET
  is_listed = 0,
  updated_at = NOW();

