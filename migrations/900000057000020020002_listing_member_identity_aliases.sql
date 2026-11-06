-- Compare equivalent Shopify REST and GraphQL IDs without rewriting retained
-- provider identities or inferring an ID from another resource type. The same
-- exact account and marketplace still bound every cross-owner comparison.
CREATE FUNCTION marketplace.normalized_listing_identity(p_provider text, p_kind text, p_value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_provider='shopify' AND p_kind='variant'
      AND p_value ~ '^(gid://shopify/ProductVariant/)?[1-9][0-9]*$'
      THEN regexp_replace(p_value,'^gid://shopify/ProductVariant/','')
    WHEN p_provider='shopify' AND p_kind='product'
      AND p_value ~ '^(gid://shopify/Product/)?[1-9][0-9]*$'
      THEN regexp_replace(p_value,'^gid://shopify/Product/','')
    ELSE p_value
  END
$$;

-- Preserve the original view shape and identity payload. Only the comparison
-- keys change, so historical source identities and audit receipts remain intact.
CREATE OR REPLACE VIEW marketplace.listing_member_retirement_sources AS
WITH direct_members AS (
  SELECT COALESCE(f.channel_id,l.channel_id) AS channel_id,
    COALESCE(f.product_variant_id,l.product_variant_id) AS variant_id,
    COALESCE(l.external_product_id,f.channel_product_id) AS product_id,
    COALESCE(l.external_variant_id,f.channel_variant_id) AS variant_external_id,
    COALESCE(l.external_sku,f.channel_sku) AS sku, f.channel_inventory_item_id AS inventory_id,
    ((l.external_variant_id IS NOT NULL AND f.channel_variant_id IS NOT NULL AND marketplace.normalized_listing_identity(lower(identity_channel.provider),'variant',l.external_variant_id)<>marketplace.normalized_listing_identity(lower(identity_channel.provider),'variant',f.channel_variant_id))
      OR (l.external_product_id IS NOT NULL AND f.channel_product_id IS NOT NULL AND marketplace.normalized_listing_identity(lower(identity_channel.provider),'product',l.external_product_id)<>marketplace.normalized_listing_identity(lower(identity_channel.provider),'product',f.channel_product_id))
      OR (l.external_sku IS NOT NULL AND f.channel_sku IS NOT NULL AND l.external_sku<>f.channel_sku)) AS conflict
  FROM channels.channel_feeds f FULL JOIN channels.channel_listings l
    ON l.channel_id=f.channel_id AND l.product_variant_id=f.product_variant_id
  LEFT JOIN channels.channels identity_channel ON identity_channel.id=COALESCE(f.channel_id,l.channel_id)
  WHERE COALESCE(l.external_variant_id,f.channel_variant_id,l.external_product_id,f.channel_product_id,l.external_sku,f.channel_sku) IS NOT NULL
), sources AS (
  SELECT v.id AS product_variant_id, v.product_id,
    concat_ws(':',p.updated_at::text,v.updated_at::text) AS source_revision,
    (NOT v.is_active OR NOT p.is_active OR p.status='archived') AS catalog_archived,
    jsonb_build_object('destinationKind','channel_connection','connectionId',cc.id,'channelId',c.id,'vendorId',NULL,
      'provider',lower(c.provider),'accountId',CASE lower(c.provider) WHEN 'ebay' THEN token.external_account_id
        WHEN 'shopify' THEN cc.shop_domain WHEN 'walmart' THEN wc.partner_id END,
      'environment',COALESCE(token.environment,wc.environment,'production'),
      'market',CASE lower(c.provider) WHEN 'ebay' THEN COALESCE(cc.metadata->>'marketplaceId','EBAY_US')
        WHEN 'walmart' THEN COALESCE(wc.market,'us') ELSE 'shop' END,
      'productId',v.product_id,'productVariantId',v.id,'externalSku',member.sku,
      'externalProductId',member.product_id,'externalVariantId',member.variant_external_id,
      'externalInventoryItemId',member.inventory_id,'identityConflict',COALESCE(member.conflict,false)) AS identity
  FROM direct_members member
  JOIN catalog.product_variants v ON v.id=member.variant_id JOIN catalog.products p ON p.id=v.product_id
  JOIN channels.channels c ON c.id=member.channel_id JOIN channels.channel_connections cc ON cc.channel_id=c.id
  LEFT JOIN ebay.ebay_oauth_tokens token ON token.channel_id=c.id AND lower(c.provider)='ebay'
    AND token.external_account_identity_scheme='provider_user_id' AND token.external_account_verified_at IS NOT NULL
  LEFT JOIN channels.walmart_connections wc ON wc.connection_id=cc.id AND lower(c.provider)='walmart'
  UNION ALL
  SELECT v.id,v.product_id,concat_ws(':',p.updated_at::text,v.updated_at::text),
    (NOT v.is_active OR NOT p.is_active OR p.status='archived'),
    jsonb_build_object('destinationKind','dropship_store_connection','connectionId',sc.id,'channelId',NULL,'vendorId',sc.vendor_id,
      'provider',lower(sc.platform),'accountId',CASE WHEN sc.platform='shopify' THEN sc.shop_domain ELSE sc.external_account_id END,
      'environment',COALESCE(sc.provider_environment,'production'),
      'market',CASE WHEN sc.platform='ebay' THEN COALESCE(intent.result->'listingIntent'->'marketplaceConfig'->>'marketplaceId','EBAY_US') ELSE 'shop' END,
      'productId',v.product_id,'productVariantId',v.id,'externalSku',intent.result->'listingIntent'->>'sku',
      'externalProductId',l.external_listing_id,'externalVariantId',l.external_offer_id,'externalInventoryItemId',NULL,'identityConflict',false)
  FROM dropship.dropship_vendor_listings l JOIN dropship.dropship_store_connections sc ON sc.id=l.store_connection_id AND sc.vendor_id=l.vendor_id
  JOIN catalog.product_variants v ON v.id=l.product_variant_id JOIN catalog.products p ON p.id=v.product_id
  LEFT JOIN LATERAL (SELECT ji.result FROM dropship.dropship_listing_push_job_items ji
    JOIN dropship.dropship_listing_push_jobs j ON j.id=ji.job_id
    WHERE ji.listing_id=l.id AND ji.product_variant_id=v.id AND j.store_connection_id=sc.id
      AND j.vendor_id=sc.vendor_id AND ji.status='completed' AND ji.action='push'
    ORDER BY ji.id DESC LIMIT 1) intent ON true
  WHERE l.external_listing_id IS NOT NULL OR l.external_offer_id IS NOT NULL
), checked_sources AS (
SELECT product_variant_id,product_id,source_revision,
  catalog_archived,
  identity || jsonb_build_object('identityConflict', (identity->>'identityConflict')::boolean
    OR count(*) OVER(PARTITION BY identity->>'destinationKind',
      CASE WHEN identity->>'destinationKind'='channel_connection' THEN identity->>'channelId' ELSE identity->>'connectionId' END,
      product_variant_id)>1
    -- Keep active identities in these windows: retiring an archived alias must
    -- never remove another Catalog member's live provider SKU or exact offer.
    -- Destination kind is intentionally absent: direct and Dropship connections
    -- can address the same provider account.
    OR (identity->>'externalSku' IS NOT NULL AND
      min(product_variant_id) OVER sku_alias <> max(product_variant_id) OVER sku_alias)
    OR (identity->>'externalVariantId' IS NOT NULL AND
      min(product_variant_id) OVER variant_alias <> max(product_variant_id) OVER variant_alias)) AS identity
FROM sources
WINDOW sku_alias AS (PARTITION BY identity->>'provider',identity->>'environment',identity->>'accountId',identity->>'market',identity->>'externalSku'),
  variant_alias AS (PARTITION BY identity->>'provider',identity->>'environment',identity->>'accountId',identity->>'market',
    marketplace.normalized_listing_identity(identity->>'provider','variant',identity->>'externalVariantId'))
)
SELECT product_variant_id,product_id,source_revision,identity FROM checked_sources WHERE catalog_archived;
