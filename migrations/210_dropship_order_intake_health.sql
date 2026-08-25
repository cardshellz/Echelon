-- Persist a provider-neutral order-intake heartbeat independently from store
-- authorization. A connected credential does not prove that orders are being
-- polled or ingested successfully.

CREATE TABLE IF NOT EXISTS dropship.dropship_store_order_intake_health (
  store_connection_id integer PRIMARY KEY
    REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  mode varchar(20) NOT NULL,
  status varchar(20) NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code varchar(100),
  last_failure_message text,
  status_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_order_intake_health_mode_chk
    CHECK (mode IN ('poll','webhook')),
  CONSTRAINT dropship_order_intake_health_status_chk
    CHECK (status IN ('healthy','warning','degraded','stopped')),
  CONSTRAINT dropship_order_intake_health_failure_count_chk
    CHECK (consecutive_failures >= 0),
  CONSTRAINT dropship_order_intake_health_failure_evidence_chk
    CHECK ((last_failure_code IS NULL) = (last_failure_message IS NULL)),
  CONSTRAINT dropship_order_intake_health_healthy_chk
    CHECK (status <> 'healthy' OR (last_success_at IS NOT NULL AND consecutive_failures = 0))
);

CREATE INDEX IF NOT EXISTS dropship_order_intake_health_status_idx
  ON dropship.dropship_store_order_intake_health(status);

CREATE INDEX IF NOT EXISTS dropship_order_intake_health_attempt_idx
  ON dropship.dropship_store_order_intake_health(last_attempt_at);

COMMENT ON TABLE dropship.dropship_store_order_intake_health IS
  'Durable provider-neutral order-intake heartbeat and failure state for each connected vendor store.';

COMMENT ON COLUMN dropship.dropship_store_order_intake_health.last_attempt_at IS
  'Most recent provider poll or verified webhook intake attempt, including failed attempts.';

COMMENT ON COLUMN dropship.dropship_store_order_intake_health.last_success_at IS
  'Most recent successful intake heartbeat. A successful zero-order poll is still a healthy heartbeat.';
