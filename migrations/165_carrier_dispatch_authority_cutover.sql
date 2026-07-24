-- Carrier-dispatch authority cutover.
--
-- A shipping-provider label is only evidence that a label exists. A matched
-- carrier event with confirmed possession creates one durable dispatch command
-- for that label. The command is the retry/idempotency boundary that promotes
-- the label into the canonical physical-shipment and channel-fulfillment flow.

CREATE TABLE IF NOT EXISTS wms.carrier_dispatch_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  carrier_tracking_event_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  command_key VARCHAR(400) NOT NULL,
  source VARCHAR(60) NOT NULL,
  created_by VARCHAR(200) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  lease_owner VARCHAR(200),
  lease_expires_at TIMESTAMPTZ,
  dispatch_occurred_at TIMESTAMPTZ NOT NULL,
  succeeded_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message TEXT,
  result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_carrier_dispatch_commands_label
    UNIQUE(shipping_provider_label_id),
  CONSTRAINT uq_carrier_dispatch_commands_key
    UNIQUE(command_key),
  CONSTRAINT carrier_dispatch_commands_status_chk CHECK (
    status IN (
      'pending',
      'processing',
      'retry_scheduled',
      'succeeded',
      'review_required'
    )
  ),
  CONSTRAINT carrier_dispatch_commands_attempt_chk CHECK (
    attempt_count >= 0 AND consecutive_failure_count >= 0
  ),
  CONSTRAINT carrier_dispatch_commands_lease_chk CHECK (
    (
      status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT carrier_dispatch_commands_retry_chk CHECK (
    (status = 'retry_scheduled' AND next_attempt_at IS NOT NULL)
    OR (status <> 'retry_scheduled' AND next_attempt_at IS NULL)
  ),
  CONSTRAINT carrier_dispatch_commands_success_chk CHECK (
    (status = 'succeeded' AND succeeded_at IS NOT NULL)
    OR (status <> 'succeeded' AND succeeded_at IS NULL)
  ),
  CONSTRAINT carrier_dispatch_commands_key_chk CHECK (
    BTRIM(command_key) <> ''
  ),
  CONSTRAINT carrier_dispatch_commands_audit_chk CHECK (
    BTRIM(source) <> '' AND BTRIM(created_by) <> ''
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_dispatch_commands_due
  ON wms.carrier_dispatch_commands(
    next_attempt_at,
    lease_expires_at,
    id
  )
  WHERE status IN ('pending', 'processing', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_carrier_dispatch_commands_status
  ON wms.carrier_dispatch_commands(status, updated_at, id);

CREATE TABLE IF NOT EXISTS wms.carrier_dispatch_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_dispatch_command_id BIGINT NOT NULL
    REFERENCES wms.carrier_dispatch_commands(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  attempt_outcome VARCHAR(30) NOT NULL,
  error_code VARCHAR(100),
  error_message TEXT,
  request_evidence JSONB NOT NULL,
  response_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_carrier_dispatch_attempts_number
    UNIQUE(carrier_dispatch_command_id, attempt_number),
  CONSTRAINT carrier_dispatch_attempts_number_chk CHECK (
    attempt_number > 0
  ),
  CONSTRAINT carrier_dispatch_attempts_outcome_chk CHECK (
    attempt_outcome IN ('succeeded', 'retry_scheduled', 'review_required')
  ),
  CONSTRAINT carrier_dispatch_attempts_time_chk CHECK (
    completed_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_dispatch_attempts_command
  ON wms.carrier_dispatch_attempts(
    carrier_dispatch_command_id,
    attempt_number
  );

DROP TRIGGER IF EXISTS carrier_dispatch_attempts_immutable
  ON wms.carrier_dispatch_attempts;
CREATE TRIGGER carrier_dispatch_attempts_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

COMMENT ON TABLE wms.carrier_dispatch_commands IS
  'Durable idempotent commands that promote confirmed carrier possession into physical shipment authority.';
COMMENT ON TABLE wms.carrier_dispatch_attempts IS
  'Append-only execution attempts for carrier dispatch commands.';
