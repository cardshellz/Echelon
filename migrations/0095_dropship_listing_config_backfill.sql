-- Dropship V2 listing config backfill.
-- Creates neutral listing configuration rows for existing active store connections.

INSERT INTO dropship.dropship_store_listing_configs (
  store_connection_id,
  platform,
  listing_mode,
  inventory_mode,
  price_mode,
  marketplace_config,
  required_config_keys,
  required_product_fields,
  is_active,
  created_at,
  updated_at
)
SELECT
  sc.id,
  sc.platform,
  'draft_first',
  'managed_quantity_sync',
  'vendor_defined',
  '{}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  true,
  now(),
  now()
FROM dropship.dropship_store_connections sc
WHERE sc.status IN ('connected','needs_reauth','refresh_failed','grace_period','paused')
ON CONFLICT (store_connection_id) DO NOTHING;
