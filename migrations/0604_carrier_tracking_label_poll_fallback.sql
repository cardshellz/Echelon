-- ShipStation tracking webhooks are the fast path, but they are not a complete
-- delivery guarantee. This durable projection leases exact provider-label
-- lookups, while the append-only attempts table preserves every provider
-- response used to decide whether a physical package was dispatched.

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_label_polls (
  shipping_provider_label_id BIGINT PRIMARY KEY
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  poll_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  last_event_id BIGINT
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  lease_owner VARCHAR(200),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_label_polls_status_chk CHECK (
    poll_status IN ('pending', 'processing', 'waiting', 'retry', 'complete', 'review', 'retired')
  ),
  CONSTRAINT carrier_tracking_label_polls_attempt_count_chk CHECK (attempt_count >= 0),
  CONSTRAINT carrier_tracking_label_polls_failure_count_chk CHECK (
    consecutive_failure_count >= 0
  ),
  CONSTRAINT carrier_tracking_label_polls_state_shape_chk CHECK (
    (
      poll_status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND next_attempt_at IS NULL
    )
    OR (
      poll_status IN ('pending', 'waiting', 'retry')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NOT NULL
      AND confirmed_at IS NULL
    )
    OR (
      poll_status = 'complete'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND confirmed_at IS NOT NULL
      AND last_event_id IS NOT NULL
    )
    OR (
      poll_status IN ('review', 'retired')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND confirmed_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_label_polls_due
  ON wms.carrier_tracking_label_polls(next_attempt_at, lease_expires_at, shipping_provider_label_id);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_label_polls_status
  ON wms.carrier_tracking_label_polls(poll_status, updated_at);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_label_poll_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_label_polls(shipping_provider_label_id)
    ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  attempt_outcome VARCHAR(30) NOT NULL,
  http_status INTEGER,
  carrier_tracking_event_id BIGINT
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  dispatch_evidence VARCHAR(30),
  error_code VARCHAR(100),
  error_message TEXT,
  request_evidence JSONB NOT NULL,
  response_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_label_poll_attempts_number_chk CHECK (
    attempt_number > 0
  ),
  CONSTRAINT carrier_tracking_label_poll_attempts_outcome_chk CHECK (
    attempt_outcome IN ('confirmed', 'waiting', 'retry_scheduled', 'review_required')
  ),
  CONSTRAINT carrier_tracking_label_poll_attempts_http_chk CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT carrier_tracking_label_poll_attempts_shape_chk CHECK (
    (
      attempt_outcome IN ('confirmed', 'waiting')
      AND http_status = 200
      AND carrier_tracking_event_id IS NOT NULL
      AND dispatch_evidence IS NOT NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR (
      attempt_outcome IN ('retry_scheduled', 'review_required')
      AND carrier_tracking_event_id IS NULL
      AND dispatch_evidence IS NULL
      AND error_code IS NOT NULL
      AND error_message IS NOT NULL
    )
  ),
  CONSTRAINT uq_carrier_tracking_label_poll_attempt_number UNIQUE (
    shipping_provider_label_id,
    attempt_number
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_label_poll_attempts_label
  ON wms.carrier_tracking_label_poll_attempts(
    shipping_provider_label_id,
    attempt_number DESC
  );

DROP TRIGGER IF EXISTS carrier_tracking_label_poll_attempts_immutable
  ON wms.carrier_tracking_label_poll_attempts;
CREATE TRIGGER carrier_tracking_label_poll_attempts_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_label_poll_attempts
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

COMMENT ON TABLE wms.carrier_tracking_label_polls IS
  'Mutable lease and retry projection for exact ShipStation label tracking lookups.';

COMMENT ON TABLE wms.carrier_tracking_label_poll_attempts IS
  'Append-only provider evidence for exact ShipStation label tracking lookups.';
