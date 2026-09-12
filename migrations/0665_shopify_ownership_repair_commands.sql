-- Inert control-plane foundation for explicit Shopify ownership repair.
-- This migration creates no command rows and changes no catalog or channel
-- mapping. Successful repair receipts are append-only audit evidence.

-- Retained inactive feed projections must be able to relinquish every remote
-- identity. Keeping a stale non-null variant ID would continue to claim the
-- Shopify variant and block the canonical owner from being repaired.
ALTER TABLE channels.channel_feeds
  ALTER COLUMN channel_variant_id DROP NOT NULL;

ALTER TABLE channels.channel_feeds
  DROP CONSTRAINT IF EXISTS channel_feeds_active_identity_chk;
ALTER TABLE channels.channel_feeds
  ADD CONSTRAINT channel_feeds_active_identity_chk
  CHECK (is_active = 0 OR NULLIF(btrim(channel_variant_id), '') IS NOT NULL)
  NOT VALID;

CREATE TABLE IF NOT EXISTS channels.shopify_ownership_repair_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL
    REFERENCES channels.channels(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  preview_hash VARCHAR(64) NOT NULL,
  operator VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  recommendations JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT shopify_ownership_repair_commands_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shopify_ownership_repair_commands_preview_hash_chk
    CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shopify_ownership_repair_commands_recommendations_chk
    CHECK (
      jsonb_typeof(recommendations) = 'array'
      AND jsonb_array_length(recommendations) > 0
    ),
  CONSTRAINT shopify_ownership_repair_commands_result_chk
    CHECK (jsonb_typeof(result) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_ownership_repair_commands_idempotency_uidx
  ON channels.shopify_ownership_repair_commands(idempotency_key);

CREATE INDEX IF NOT EXISTS shopify_ownership_repair_commands_channel_created_idx
  ON channels.shopify_ownership_repair_commands(channel_id, created_at);

CREATE OR REPLACE FUNCTION channels.reject_shopify_ownership_repair_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Shopify ownership repair command receipts are immutable; append a new command'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS shopify_ownership_repair_commands_immutable
  ON channels.shopify_ownership_repair_commands;
CREATE TRIGGER shopify_ownership_repair_commands_immutable
  BEFORE UPDATE OR DELETE ON channels.shopify_ownership_repair_commands
  FOR EACH ROW
  EXECUTE FUNCTION channels.reject_shopify_ownership_repair_command_mutation();

DROP TRIGGER IF EXISTS shopify_ownership_repair_commands_no_truncate
  ON channels.shopify_ownership_repair_commands;
CREATE TRIGGER shopify_ownership_repair_commands_no_truncate
  BEFORE TRUNCATE ON channels.shopify_ownership_repair_commands
  FOR EACH STATEMENT
  EXECUTE FUNCTION channels.reject_shopify_ownership_repair_command_mutation();
