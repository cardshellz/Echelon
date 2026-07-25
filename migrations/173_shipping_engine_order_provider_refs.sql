-- One logical shipping-engine order may be represented by multiple provider
-- order records when a provider splits, combines, or recreates packages.
-- Physical package identity remains provider + provider_physical_shipment_id.

BEGIN;

CREATE TABLE IF NOT EXISTS wms.shipping_engine_order_provider_refs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_engine_order_id BIGINT NOT NULL
    REFERENCES wms.shipping_engine_orders(id) ON DELETE RESTRICT,
  provider VARCHAR(40) NOT NULL,
  provider_order_id VARCHAR(200) NOT NULL,
  source VARCHAR(50) NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_engine_order_provider_refs_provider_chk
    CHECK (BTRIM(provider) <> ''),
  CONSTRAINT shipping_engine_order_provider_refs_order_id_chk
    CHECK (BTRIM(provider_order_id) <> ''),
  CONSTRAINT shipping_engine_order_provider_refs_source_chk
    CHECK (BTRIM(source) <> ''),
  CONSTRAINT shipping_engine_order_provider_refs_observed_range_chk
    CHECK (first_observed_at <= last_observed_at),
  CONSTRAINT uq_shipping_engine_order_provider_refs_identity
    UNIQUE(provider, provider_order_id)
);

CREATE INDEX IF NOT EXISTS idx_shipping_engine_order_provider_refs_order
  ON wms.shipping_engine_order_provider_refs(shipping_engine_order_id, id);

INSERT INTO wms.shipping_engine_order_provider_refs (
  shipping_engine_order_id,
  provider,
  provider_order_id,
  source,
  first_observed_at,
  last_observed_at,
  metadata,
  created_at,
  updated_at
)
SELECT
  engine.id,
  engine.provider,
  engine.provider_order_id,
  'shipping_engine_order_backfill',
  engine.created_at,
  COALESCE(engine.last_sync_at, engine.updated_at, engine.created_at),
  jsonb_build_object('primaryCompatibilityReference', true),
  NOW(),
  NOW()
FROM wms.shipping_engine_orders AS engine
WHERE NULLIF(BTRIM(engine.provider_order_id), '') IS NOT NULL
ON CONFLICT (provider, provider_order_id) DO NOTHING;

COMMIT;
