-- Activates continuous WMS inventory integrity monitoring without granting the
-- monitor authority over inventory state. The singleton state records the
-- explicit stabilization watermark. Alert delivery uses a durable outbox so a
-- webhook failure cannot discard a detected regression.

CREATE TABLE IF NOT EXISTS inventory.integrity_monitor_state (
  singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE,
  baseline_run_id VARCHAR(36) NOT NULL UNIQUE
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  stabilization_started_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  activated_by VARCHAR(120) NOT NULL,
  last_successful_run_id VARCHAR(36)
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  last_successful_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_code VARCHAR(100),
  last_failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_monitor_state_singleton_chk CHECK (singleton_key),
  CONSTRAINT integrity_monitor_state_actor_chk CHECK (btrim(activated_by) <> ''),
  CONSTRAINT integrity_monitor_state_success_chk CHECK (
    (last_successful_run_id IS NULL) = (last_successful_at IS NULL)
  ),
  CONSTRAINT integrity_monitor_state_failure_chk CHECK (
    (last_failure_at IS NULL AND last_failure_code IS NULL AND last_failure_message IS NULL)
    OR
    (last_failure_at IS NOT NULL AND last_failure_code IS NOT NULL AND last_failure_message IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS inventory.integrity_alert_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL UNIQUE
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  signature VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  trigger_counts JSONB NOT NULL,
  payload JSONB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner VARCHAR(120),
  lease_expires_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_alert_outbox_status_chk
    CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  CONSTRAINT integrity_alert_outbox_signature_chk
    CHECK (signature ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integrity_alert_outbox_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT integrity_alert_outbox_payload_chk CHECK (
    jsonb_typeof(trigger_counts) = 'object'
    AND jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT integrity_alert_outbox_lease_chk CHECK (
    (status = 'sending' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'sending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT integrity_alert_outbox_sent_chk CHECK (
    (status = 'sent') = (sent_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_integrity_alert_outbox_due
  ON inventory.integrity_alert_outbox (next_attempt_at, id)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_integrity_alert_outbox_status
  ON inventory.integrity_alert_outbox (status, created_at DESC);
