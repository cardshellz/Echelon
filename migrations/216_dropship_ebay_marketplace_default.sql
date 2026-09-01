-- Dropship eBay currently operates against the US marketplace. Existing
-- listing configs predate connection-time prerequisite discovery and may have
-- an empty marketplace_config object. Add only the missing marketplace key;
-- never overwrite an explicitly configured marketplace.
UPDATE dropship.dropship_store_listing_configs
SET marketplace_config = COALESCE(marketplace_config, '{}'::jsonb)
      || jsonb_build_object('marketplaceId', 'EBAY_US'),
    updated_at = NOW()
WHERE platform = 'ebay'
  AND NOT (COALESCE(marketplace_config, '{}'::jsonb) ? 'marketplaceId');
