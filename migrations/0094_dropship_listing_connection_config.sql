-- Dropship V2 listing connection configuration and push-job idempotency.
-- Canonical design: DROPSHIP-V2-CONSOLIDATED-DESIGN.md

CREATE TABLE IF NOT EXISTS dropship.dropship_store_listing_configs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  platform varchar(30) NOT NULL,
  listing_mode varchar(40) NOT NULL,
  inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync',
  price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined',
  marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_store_listing_config_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_store_listing_config_mode_chk CHECK (listing_mode IN ('draft_first','live','manual_only')),
  CONSTRAINT dropship_store_listing_config_inventory_chk CHECK (inventory_mode IN ('managed_quantity_sync','manual_quantity','disabled')),
  CONSTRAINT dropship_store_listing_config_price_chk CHECK (price_mode IN ('vendor_defined','connection_default','disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_listing_config_store_idx
  ON dropship.dropship_store_listing_configs(store_connection_id);

CREATE INDEX IF NOT EXISTS dropship_store_listing_config_platform_idx
  ON dropship.dropship_store_listing_configs(platform, is_active);

ALTER TABLE dropship.dropship_listing_push_jobs
  ADD COLUMN IF NOT EXISTS request_hash varchar(128);

DROP INDEX IF EXISTS dropship.dropship_listing_job_idem_idx;

CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_job_idem_idx
  ON dropship.dropship_listing_push_jobs(vendor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
