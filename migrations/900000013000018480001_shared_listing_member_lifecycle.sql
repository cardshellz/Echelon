CREATE TABLE marketplace.listing_member_retirements (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL CHECK (identity_key ~ '^[a-f0-9]{64}$'),
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity)='object'),
  source_identity jsonb NOT NULL CHECK (jsonb_typeof(source_identity)='object'),
  source_revision text NOT NULL,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  state text NOT NULL CHECK (state IN ('pending','retiring','retired','failed','superseded')),
  code text,
  message text,
  verified_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  UNIQUE(identity_key,source_revision),
  CHECK ((state='retired')=(verified_at IS NOT NULL)),
  CHECK ((state IN ('retired','superseded') OR (state='failed' AND COALESCE(code='LISTING_MEMBER_IDENTITY_INVALID',false)))=(next_attempt_at IS NULL)),
  CHECK ((identity->>'productId')::integer=product_id AND (identity->>'productVariantId')::integer=product_variant_id)
);
CREATE INDEX listing_member_retirements_due ON marketplace.listing_member_retirements(next_attempt_at,id) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX listing_member_retirements_variant ON marketplace.listing_member_retirements(product_variant_id);
CREATE INDEX listing_member_retirements_source ON marketplace.listing_member_retirements(md5(source_identity::text),source_revision);
CREATE TABLE marketplace.listing_member_retirement_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES marketplace.listing_member_retirements(id),
  version integer NOT NULL,
  actor text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(operation_id,version)
);
CREATE FUNCTION marketplace.guard_listing_member_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Listing member retirement history is immutable'; END IF;
  IF (NEW.id,NEW.identity_key,NEW.identity,NEW.source_identity,NEW.source_revision,NEW.product_id,NEW.product_variant_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.identity_key,OLD.identity,OLD.source_identity,OLD.source_revision,OLD.product_id,OLD.product_variant_id,OLD.created_at)
      OR OLD.state IN ('retired','superseded') OR (OLD.state='failed' AND OLD.code='LISTING_MEMBER_IDENTITY_INVALID') THEN
    RAISE EXCEPTION 'Listing member retirement identity and terminal evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listing_member_retirement_identity BEFORE UPDATE OR DELETE ON marketplace.listing_member_retirements
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_member_retirement();
CREATE TRIGGER listing_member_retirement_events_immutable BEFORE UPDATE OR DELETE ON marketplace.listing_member_retirement_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();

-- Read-only projection of retained identities. Catalog SKU is deliberately not
-- a fallback: renaming a local SKU must not address a different remote item.
CREATE OR REPLACE VIEW marketplace.listing_member_retirement_sources AS
WITH direct_members AS (
  SELECT COALESCE(f.channel_id,l.channel_id) AS channel_id,
    COALESCE(f.product_variant_id,l.product_variant_id) AS variant_id,
    COALESCE(l.external_product_id,f.channel_product_id) AS product_id,
    COALESCE(l.external_variant_id,f.channel_variant_id) AS variant_external_id,
    COALESCE(l.external_sku,f.channel_sku) AS sku, f.channel_inventory_item_id AS inventory_id,
    ((l.external_variant_id IS NOT NULL AND f.channel_variant_id IS NOT NULL AND l.external_variant_id<>f.channel_variant_id)
      OR (l.external_product_id IS NOT NULL AND f.channel_product_id IS NOT NULL AND l.external_product_id<>f.channel_product_id)
      OR (l.external_sku IS NOT NULL AND f.channel_sku IS NOT NULL AND l.external_sku<>f.channel_sku)) AS conflict
  FROM channels.channel_feeds f FULL JOIN channels.channel_listings l
    ON l.channel_id=f.channel_id AND l.product_variant_id=f.product_variant_id
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
  variant_alias AS (PARTITION BY identity->>'provider',identity->>'environment',identity->>'accountId',identity->>'market',identity->>'externalVariantId')
)
SELECT product_variant_id,product_id,source_revision,identity FROM checked_sources WHERE catalog_archived;
