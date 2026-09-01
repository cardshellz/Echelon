-- Phase 1 package-allocation effect delivery foundation.
-- Every immutable intent receives one durable idempotency row, but this
-- migration deliberately permits only the non-dispatchable shadow state.

CREATE TABLE wms.package_allocation_effect_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_effect_intent_id BIGINT NOT NULL
    REFERENCES wms.package_allocation_effect_intents(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(500) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  state VARCHAR(30) NOT NULL DEFAULT 'shadow',
  execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ,
  lease_token VARCHAR(120),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_package_allocation_effect_outbox_intent
    UNIQUE (package_allocation_effect_intent_id),
  CONSTRAINT uq_package_allocation_effect_outbox_idempotency
    UNIQUE (idempotency_key),
  CONSTRAINT package_allocation_effect_outbox_identity_chk CHECK (
    char_length(btrim(idempotency_key)) BETWEEN 1 AND 500
    AND payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT package_allocation_effect_outbox_inert_chk CHECK (
    state = 'shadow'
    AND execution_enabled = FALSE
    AND attempt_count = 0
    AND available_at IS NULL
    AND lease_token IS NULL
    AND lease_expires_at IS NULL
    AND last_error_code IS NULL
    AND last_error_message IS NULL
  ),
  CONSTRAINT package_allocation_effect_outbox_time_chk
    CHECK (updated_at >= created_at)
);

CREATE INDEX idx_package_allocation_effect_outbox_dispatch
  ON wms.package_allocation_effect_outbox(state, execution_enabled, id);

INSERT INTO wms.package_allocation_effect_outbox (
  package_allocation_effect_intent_id,
  idempotency_key,
  payload_hash,
  state,
  execution_enabled,
  created_at,
  updated_at
)
SELECT
  intent.id,
  intent.intent_key,
  intent.payload_hash,
  'shadow',
  FALSE,
  intent.created_at,
  intent.created_at
FROM wms.package_allocation_effect_intents AS intent
ORDER BY intent.id;

CREATE OR REPLACE FUNCTION wms.guard_package_allocation_effect_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  persisted_intent_key VARCHAR(500);
  persisted_payload_hash VARCHAR(64);
BEGIN
  SELECT intent.intent_key, intent.payload_hash
    INTO persisted_intent_key, persisted_payload_hash
  FROM wms.package_allocation_effect_intents AS intent
  WHERE intent.id = NEW.package_allocation_effect_intent_id
  FOR KEY SHARE;

  IF persisted_intent_key IS NULL THEN
    RAISE EXCEPTION 'package allocation effect outbox intent does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM persisted_intent_key
     OR NEW.payload_hash IS DISTINCT FROM persisted_payload_hash THEN
    RAISE EXCEPTION 'package allocation effect outbox identity differs from its intent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_package_allocation_effect_outbox_insert_guard
BEFORE INSERT ON wms.package_allocation_effect_outbox
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_effect_outbox_insert();

CREATE TRIGGER trg_package_allocation_effect_outbox_immutable
BEFORE UPDATE OR DELETE ON wms.package_allocation_effect_outbox
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

COMMENT ON TABLE wms.package_allocation_effect_outbox IS
  'Phase 1 shadow delivery identities for package-allocation effects. No worker consumes these rows.';
