-- Audited command boundary for consolidating duplicate local product families
-- that point at one Shopify product. Deployment is inert: it creates no rows
-- and changes no catalog, inventory, reservation, transformation, channel, or
-- provider state. A separately authorized command must pass fresh evidence.

CREATE TABLE IF NOT EXISTS channels.shopify_product_consolidation_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL
    REFERENCES channels.channels(id) ON DELETE RESTRICT,
  shopify_product_id VARCHAR(100) NOT NULL,
  canonical_product_id INTEGER NOT NULL
    REFERENCES catalog.products(id) ON DELETE RESTRICT,
  source_product_ids JSONB NOT NULL,
  idempotency_key UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  preview_hash VARCHAR(64) NOT NULL,
  operator VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  evidence JSONB NOT NULL,
  plan JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT shopify_product_consolidation_shopify_id_chk
    CHECK (shopify_product_id ~ '^[0-9]+$'),
  CONSTRAINT shopify_product_consolidation_source_products_chk
    CHECK (
      jsonb_typeof(source_product_ids) = 'array'
      AND jsonb_array_length(source_product_ids) > 0
    ),
  CONSTRAINT shopify_product_consolidation_hashes_chk
    CHECK (
      request_hash ~ '^[0-9a-f]{64}$'
      AND preview_hash ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT shopify_product_consolidation_operator_chk
    CHECK (char_length(btrim(operator)) BETWEEN 1 AND 120),
  CONSTRAINT shopify_product_consolidation_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT shopify_product_consolidation_evidence_chk
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT shopify_product_consolidation_plan_chk
    CHECK (jsonb_typeof(plan) = 'object'),
  CONSTRAINT shopify_product_consolidation_result_chk
    CHECK (jsonb_typeof(result) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_product_consolidation_commands_idempotency_uidx
  ON channels.shopify_product_consolidation_commands(idempotency_key);

CREATE INDEX IF NOT EXISTS shopify_product_consolidation_commands_scope_idx
  ON channels.shopify_product_consolidation_commands(
    channel_id,
    shopify_product_id,
    created_at DESC
  );

CREATE OR REPLACE FUNCTION channels.reject_shopify_product_consolidation_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Shopify product consolidation command receipts are immutable; append a new command'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS shopify_product_consolidation_commands_immutable
  ON channels.shopify_product_consolidation_commands;
CREATE TRIGGER shopify_product_consolidation_commands_immutable
  BEFORE UPDATE OR DELETE ON channels.shopify_product_consolidation_commands
  FOR EACH ROW
  EXECUTE FUNCTION channels.reject_shopify_product_consolidation_command_mutation();

DROP TRIGGER IF EXISTS shopify_product_consolidation_commands_no_truncate
  ON channels.shopify_product_consolidation_commands;
CREATE TRIGGER shopify_product_consolidation_commands_no_truncate
  BEFORE TRUNCATE ON channels.shopify_product_consolidation_commands
  FOR EACH STATEMENT
  EXECUTE FUNCTION channels.reject_shopify_product_consolidation_command_mutation();
