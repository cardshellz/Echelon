-- Durable lifecycle registry for the read-only WMS inventory integrity audit.
--
-- These tables record audit evidence only. They do not own or mutate inventory
-- quantities. Finding state is mutable so the registry can represent open,
-- acknowledged, resolved, recurrent, and accepted historical exceptions. The
-- observation stream is append-only.

CREATE TABLE IF NOT EXISTS inventory.integrity_audit_runs (
  id VARCHAR(36) PRIMARY KEY,
  scope VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  source_version VARCHAR(100),
  started_at TIMESTAMPTZ NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  database_name VARCHAR(200) NOT NULL,
  database_user VARCHAR(200) NOT NULL,
  server_version VARCHAR(100) NOT NULL,
  recovery_mode BOOLEAN NOT NULL,
  check_count INTEGER NOT NULL,
  blocker_count BIGINT NOT NULL,
  warning_count BIGINT NOT NULL,
  finding_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_audit_runs_scope_chk
    CHECK (scope IN ('all', 'continuous', 'targeted')),
  CONSTRAINT integrity_audit_runs_status_chk
    CHECK (status = 'completed'),
  CONSTRAINT integrity_audit_runs_counts_chk
    CHECK (
      check_count >= 0
      AND blocker_count >= 0
      AND warning_count >= 0
      AND finding_count >= 0
      AND finding_count = blocker_count + warning_count
    ),
  CONSTRAINT integrity_audit_runs_time_chk
    CHECK (completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_integrity_audit_runs_snapshot
  ON inventory.integrity_audit_runs (snapshot_at DESC);

CREATE TABLE IF NOT EXISTS inventory.integrity_audit_run_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  check_id VARCHAR(100) NOT NULL,
  category VARCHAR(30) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  finding_count BIGINT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_audit_run_checks_severity_chk
    CHECK (severity IN ('blocker', 'warning')),
  CONSTRAINT integrity_audit_run_checks_count_chk
    CHECK (finding_count >= 0 AND elapsed_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrity_audit_run_checks_run_check
  ON inventory.integrity_audit_run_checks (run_id, check_id);

CREATE INDEX IF NOT EXISTS idx_integrity_audit_run_checks_check
  ON inventory.integrity_audit_run_checks (check_id, run_id);

CREATE TABLE IF NOT EXISTS inventory.integrity_findings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id VARCHAR(100) NOT NULL,
  entity_fingerprint VARCHAR(64) NOT NULL,
  category VARCHAR(30) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  entity_key JSONB NOT NULL,
  current_evidence JSONB NOT NULL,
  current_evidence_hash VARCHAR(64) NOT NULL,
  current_metric NUMERIC(38, 0) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_changed_at TIMESTAMPTZ NOT NULL,
  first_seen_run_id VARCHAR(36) NOT NULL
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  last_seen_run_id VARCHAR(36) NOT NULL
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  worsened_count INTEGER NOT NULL DEFAULT 0,
  last_observation_kind VARCHAR(20) NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(120),
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(120),
  resolution TEXT,
  remediation_run_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_findings_severity_chk
    CHECK (severity IN ('blocker', 'warning')),
  CONSTRAINT integrity_findings_status_chk
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'accepted_exception')),
  CONSTRAINT integrity_findings_observation_kind_chk
    CHECK (last_observation_kind IN (
      'new', 'unchanged', 'changed', 'worsened', 'improved', 'recurred', 'resolved'
    )),
  CONSTRAINT integrity_findings_fingerprint_chk
    CHECK (entity_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integrity_findings_evidence_hash_chk
    CHECK (current_evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integrity_findings_counts_chk
    CHECK (
      current_metric >= 0
      AND occurrence_count > 0
      AND recurrence_count >= 0
      AND worsened_count >= 0
    ),
  CONSTRAINT integrity_findings_time_chk
    CHECK (last_seen_at >= first_seen_at AND last_changed_at >= first_seen_at),
  CONSTRAINT integrity_findings_resolution_state_chk
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrity_findings_check_entity
  ON inventory.integrity_findings (check_id, entity_fingerprint);

CREATE INDEX IF NOT EXISTS idx_integrity_findings_open
  ON inventory.integrity_findings (severity, check_id, last_seen_at DESC)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_integrity_findings_status
  ON inventory.integrity_findings (status, check_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS inventory.integrity_finding_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id BIGINT NOT NULL
    REFERENCES inventory.integrity_findings(id) ON DELETE RESTRICT,
  run_id VARCHAR(36) NOT NULL
    REFERENCES inventory.integrity_audit_runs(id) ON DELETE RESTRICT,
  observation_kind VARCHAR(20) NOT NULL,
  prior_status VARCHAR(30),
  observed_metric NUMERIC(38, 0) NOT NULL,
  evidence_hash VARCHAR(64) NOT NULL,
  evidence JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integrity_finding_observations_kind_chk
    CHECK (observation_kind IN (
      'new', 'changed', 'worsened', 'improved', 'recurred', 'resolved'
    )),
  CONSTRAINT integrity_finding_observations_prior_status_chk
    CHECK (
      prior_status IS NULL
      OR prior_status IN ('open', 'acknowledged', 'resolved', 'accepted_exception')
    ),
  CONSTRAINT integrity_finding_observations_hash_chk
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integrity_finding_observations_metric_chk
    CHECK (observed_metric >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrity_finding_observations_run_finding_kind
  ON inventory.integrity_finding_observations (run_id, finding_id, observation_kind);

CREATE INDEX IF NOT EXISTS idx_integrity_finding_observations_finding
  ON inventory.integrity_finding_observations (finding_id, observed_at DESC);

CREATE OR REPLACE FUNCTION inventory.reject_integrity_observation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'integrity finding observations are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS integrity_finding_observations_immutable_guard
  ON inventory.integrity_finding_observations;

CREATE TRIGGER integrity_finding_observations_immutable_guard
BEFORE UPDATE OR DELETE ON inventory.integrity_finding_observations
FOR EACH ROW
EXECUTE FUNCTION inventory.reject_integrity_observation_mutation();
