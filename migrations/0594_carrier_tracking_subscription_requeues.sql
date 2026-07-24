CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscription_requeues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_subscription_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_subscriptions(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(200) NOT NULL,
  operator VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  previous_status VARCHAR(30) NOT NULL,
  previous_attempt_count INTEGER NOT NULL,
  previous_consecutive_failure_count INTEGER NOT NULL,
  previous_error_code VARCHAR(100),
  previous_error_message TEXT,
  previous_http_status INTEGER,
  previous_response_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_subscription_requeues_idempotency_chk CHECK (
    BTRIM(idempotency_key) <> ''
  ),
  CONSTRAINT carrier_tracking_subscription_requeues_operator_chk CHECK (
    BTRIM(operator) <> ''
  ),
  CONSTRAINT carrier_tracking_subscription_requeues_reason_chk CHECK (
    BTRIM(reason) <> ''
  ),
  CONSTRAINT carrier_tracking_subscription_requeues_previous_status_chk CHECK (
    previous_status = 'review'
  ),
  CONSTRAINT carrier_tracking_subscription_requeues_attempts_chk CHECK (
    previous_attempt_count >= 0
    AND previous_consecutive_failure_count >= 0
  ),
  CONSTRAINT carrier_tracking_subscription_requeues_http_status_chk CHECK (
    previous_http_status IS NULL
    OR previous_http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT uq_carrier_tracking_subscription_requeues_idempotency UNIQUE (
    carrier_tracking_subscription_id,
    idempotency_key
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_subscription_requeues_subscription
  ON wms.carrier_tracking_subscription_requeues(
    carrier_tracking_subscription_id,
    created_at DESC,
    id DESC
  );

COMMENT ON TABLE wms.carrier_tracking_subscription_requeues IS
  'Immutable operator audit for explicitly moving a corrected carrier tracking subscription from review back to pending.';
