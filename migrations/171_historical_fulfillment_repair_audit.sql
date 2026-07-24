-- Audited, idempotent requeue boundaries for historical fulfillment repair.
--
-- Immutable provider/channel attempts remain untouched. A requeue records the
-- exact prior projection before moving a reviewed command back to pending.

BEGIN;

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_push_requeues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_fulfillment_push_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(200) NOT NULL,
  operator VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  previous_status VARCHAR(30) NOT NULL,
  previous_attempt_count INTEGER NOT NULL,
  previous_error_code VARCHAR(100),
  previous_error_message TEXT,
  previous_request_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_channel_fulfillment_push_requeues_idempotency
    UNIQUE(channel_fulfillment_push_id, idempotency_key),
  CONSTRAINT channel_fulfillment_push_requeues_operator_chk CHECK (
    BTRIM(operator) <> ''
  ),
  CONSTRAINT channel_fulfillment_push_requeues_key_chk CHECK (
    BTRIM(idempotency_key) <> ''
  ),
  CONSTRAINT channel_fulfillment_push_requeues_reason_chk CHECK (
    BTRIM(reason) <> ''
  ),
  CONSTRAINT channel_fulfillment_push_requeues_status_chk CHECK (
    previous_status = 'review'
  ),
  CONSTRAINT channel_fulfillment_push_requeues_attempt_chk CHECK (
    previous_attempt_count >= 0
  ),
  CONSTRAINT channel_fulfillment_push_requeues_hash_chk CHECK (
    previous_request_hash IS NULL OR LENGTH(previous_request_hash) = 64
  )
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_push_requeues_command
  ON oms.channel_fulfillment_push_requeues(
    channel_fulfillment_push_id,
    created_at,
    id
  );

DROP TRIGGER IF EXISTS channel_fulfillment_push_requeues_immutable
  ON oms.channel_fulfillment_push_requeues;
CREATE TRIGGER channel_fulfillment_push_requeues_immutable
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_requeues
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

CREATE TABLE IF NOT EXISTS wms.carrier_dispatch_command_requeues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_dispatch_command_id BIGINT NOT NULL
    REFERENCES wms.carrier_dispatch_commands(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(200) NOT NULL,
  operator VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  repair_cohort VARCHAR(100) NOT NULL,
  previous_status VARCHAR(30) NOT NULL,
  previous_attempt_count INTEGER NOT NULL,
  previous_consecutive_failure_count INTEGER NOT NULL,
  previous_error_code VARCHAR(100),
  previous_error_message TEXT,
  previous_result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_carrier_dispatch_command_requeues_idempotency
    UNIQUE(carrier_dispatch_command_id, idempotency_key),
  CONSTRAINT carrier_dispatch_command_requeues_operator_chk CHECK (
    BTRIM(operator) <> ''
  ),
  CONSTRAINT carrier_dispatch_command_requeues_key_chk CHECK (
    BTRIM(idempotency_key) <> ''
  ),
  CONSTRAINT carrier_dispatch_command_requeues_reason_chk CHECK (
    BTRIM(reason) <> ''
  ),
  CONSTRAINT carrier_dispatch_command_requeues_cohort_chk CHECK (
    BTRIM(repair_cohort) <> ''
  ),
  CONSTRAINT carrier_dispatch_command_requeues_status_chk CHECK (
    previous_status = 'review_required'
  ),
  CONSTRAINT carrier_dispatch_command_requeues_attempt_chk CHECK (
    previous_attempt_count >= 0
    AND previous_consecutive_failure_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_dispatch_command_requeues_command
  ON wms.carrier_dispatch_command_requeues(
    carrier_dispatch_command_id,
    created_at,
    id
  );

DROP TRIGGER IF EXISTS carrier_dispatch_command_requeues_immutable
  ON wms.carrier_dispatch_command_requeues;
CREATE TRIGGER carrier_dispatch_command_requeues_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_dispatch_command_requeues
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

COMMENT ON TABLE oms.channel_fulfillment_push_requeues IS
  'Append-only audit of guarded immutable channel-command requeues.';
COMMENT ON TABLE wms.carrier_dispatch_command_requeues IS
  'Append-only audit of guarded historical carrier-dispatch command requeues.';

COMMIT;
