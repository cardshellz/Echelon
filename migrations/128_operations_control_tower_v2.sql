-- Persistent Operations Control Tower read model.
--
-- Domain systems remain authoritative. These tables materialize current
-- operational exceptions, collector health, and operator triage so the
-- interactive UI never has to recompute cross-domain health.

CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS operations.control_tower_source_runs (
  id VARCHAR(36) PRIMARY KEY,
  source_name VARCHAR(120) NOT NULL,
  projector_version INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL,
  complete_scan BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  rows_scanned INTEGER NOT NULL DEFAULT 0,
  rows_created INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_resolved INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  source_watermark TIMESTAMPTZ,
  cursor JSONB,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_tower_source_runs_status_chk
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  CONSTRAINT control_tower_source_runs_version_chk
    CHECK (projector_version > 0),
  CONSTRAINT control_tower_source_runs_counts_chk
    CHECK (
      rows_scanned >= 0
      AND rows_created >= 0
      AND rows_updated >= 0
      AND rows_resolved >= 0
      AND rows_failed >= 0
      AND (duration_ms IS NULL OR duration_ms >= 0)
    ),
  CONSTRAINT control_tower_source_runs_completion_chk
    CHECK (
      (status = 'running' AND completed_at IS NULL AND duration_ms IS NULL)
      OR
      (status <> 'running' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL)
    ),
  CONSTRAINT control_tower_source_runs_error_chk
    CHECK (
      (status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
      OR status <> 'failed'
    )
);

CREATE INDEX IF NOT EXISTS idx_control_tower_source_runs_source_started
  ON operations.control_tower_source_runs (source_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_control_tower_source_runs_failures
  ON operations.control_tower_source_runs (started_at DESC)
  WHERE status IN ('partial', 'failed');

CREATE TABLE IF NOT EXISTS operations.control_tower_work_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_namespace VARCHAR(120) NOT NULL,
  source_type VARCHAR(80) NOT NULL,
  source_key VARCHAR(200) NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  projection_version INTEGER NOT NULL,
  domain VARCHAR(30) NOT NULL,
  code VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(200) NOT NULL,
  entity_ref VARCHAR(200),
  correlation_id VARCHAR(200),
  root_cause_group_key VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  summary TEXT NOT NULL,
  expected_state TEXT NOT NULL,
  actual_state TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL,
  urgency VARCHAR(20) NOT NULL DEFAULT 'normal',
  impact_tags VARCHAR(30)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(30)[],
  actionability VARCHAR(30) NOT NULL,
  source_status VARCHAR(30) NOT NULL,
  triage_status VARCHAR(30) NOT NULL DEFAULT 'needs_attention',
  owner_team VARCHAR(50),
  assigned_user_id VARCHAR(120),
  assigned_by VARCHAR(120),
  recommended_action TEXT NOT NULL,
  response_due_at TIMESTAMPTZ,
  next_review_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_changed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  worsened_count INTEGER NOT NULL DEFAULT 0,
  evidence_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  detail_locator JSONB NOT NULL DEFAULT '{}'::JSONB,
  available_actions JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_updated_at TIMESTAMPTZ NOT NULL,
  last_source_run_id VARCHAR(36)
    REFERENCES operations.control_tower_source_runs(id) ON DELETE SET NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      COALESCE(title, '') || ' ' ||
      COALESCE(summary, '') || ' ' ||
      COALESCE(entity_ref, '') || ' ' ||
      COALESCE(entity_id, '') || ' ' ||
      COALESCE(code, '')
    )
  ) STORED,
  CONSTRAINT control_tower_work_items_identity_uq
    UNIQUE (source_namespace, source_type, source_key),
  CONSTRAINT control_tower_work_items_source_fingerprint_chk
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT control_tower_work_items_projection_version_chk
    CHECK (projection_version > 0),
  CONSTRAINT control_tower_work_items_domain_chk
    CHECK (domain IN ('oms', 'wms', 'shipping', 'inventory', 'procurement')),
  CONSTRAINT control_tower_work_items_severity_chk
    CHECK (severity IN ('blocker', 'high', 'medium', 'low')),
  CONSTRAINT control_tower_work_items_urgency_chk
    CHECK (urgency IN ('overdue', 'due_soon', 'normal', 'deferred')),
  CONSTRAINT control_tower_work_items_actionability_chk
    CHECK (actionability IN ('investigate', 'monitor', 'automated', 'none')),
  CONSTRAINT control_tower_work_items_source_status_chk
    CHECK (source_status IN ('open', 'acknowledged', 'resolved', 'ignored')),
  CONSTRAINT control_tower_work_items_triage_status_chk
    CHECK (triage_status IN ('needs_attention', 'in_progress', 'waiting', 'resolved')),
  CONSTRAINT control_tower_work_items_counts_chk
    CHECK (
      occurrence_count > 0
      AND recurrence_count >= 0
      AND worsened_count >= 0
      AND row_version > 0
    ),
  CONSTRAINT control_tower_work_items_time_chk
    CHECK (last_seen_at >= first_seen_at AND last_changed_at >= first_seen_at),
  CONSTRAINT control_tower_work_items_resolution_chk
    CHECK ((triage_status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT control_tower_work_items_evidence_chk
    CHECK (
      jsonb_typeof(evidence_summary) = 'object'
      AND jsonb_typeof(detail_locator) = 'object'
      AND jsonb_typeof(available_actions) = 'array'
    )
);

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_queue
  ON operations.control_tower_work_items (
    triage_status,
    severity,
    response_due_at,
    first_seen_at,
    id
  );

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_open_queue
  ON operations.control_tower_work_items (domain, severity, first_seen_at, id)
  WHERE triage_status <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_assignment
  ON operations.control_tower_work_items (
    owner_team,
    assigned_user_id,
    triage_status,
    first_seen_at
  );

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_entity
  ON operations.control_tower_work_items (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_root_cause
  ON operations.control_tower_work_items (root_cause_group_key)
  WHERE root_cause_group_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_source
  ON operations.control_tower_work_items (
    source_namespace,
    source_type,
    source_status,
    source_updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_control_tower_work_items_search
  ON operations.control_tower_work_items USING GIN (search_document);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_pushes_control_tower
  ON oms.channel_fulfillment_pushes (push_status, created_at, id)
  WHERE push_status IN ('failed', 'review', 'pending');

CREATE TABLE IF NOT EXISTS operations.control_tower_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id BIGINT NOT NULL
    REFERENCES operations.control_tower_work_items(id) ON DELETE RESTRICT,
  source_run_id VARCHAR(36)
    REFERENCES operations.control_tower_source_runs(id) ON DELETE SET NULL,
  observation_kind VARCHAR(30) NOT NULL,
  prior_source_status VARCHAR(30),
  current_source_status VARCHAR(30),
  prior_triage_status VARCHAR(30),
  current_triage_status VARCHAR(30),
  changed_fields JSONB NOT NULL DEFAULT '{}'::JSONB,
  evidence_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  observed_metric NUMERIC(38, 0),
  actor_user_id VARCHAR(120),
  note TEXT,
  source_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_tower_observations_kind_chk
    CHECK (observation_kind IN (
      'new',
      'changed',
      'reopened',
      'resolved',
      'acknowledged',
      'assigned',
      'snoozed',
      'review_due'
    )),
  CONSTRAINT control_tower_observations_source_status_chk
    CHECK (
      (prior_source_status IS NULL OR prior_source_status IN ('open', 'acknowledged', 'resolved', 'ignored'))
      AND
      (current_source_status IS NULL OR current_source_status IN ('open', 'acknowledged', 'resolved', 'ignored'))
    ),
  CONSTRAINT control_tower_observations_triage_status_chk
    CHECK (
      (prior_triage_status IS NULL OR prior_triage_status IN ('needs_attention', 'in_progress', 'waiting', 'resolved'))
      AND
      (current_triage_status IS NULL OR current_triage_status IN ('needs_attention', 'in_progress', 'waiting', 'resolved'))
    ),
  CONSTRAINT control_tower_observations_json_chk
    CHECK (
      jsonb_typeof(changed_fields) = 'object'
      AND jsonb_typeof(evidence_summary) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_control_tower_observations_item_created
  ON operations.control_tower_observations (work_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_control_tower_observations_run
  ON operations.control_tower_observations (source_run_id, id)
  WHERE source_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION operations.reject_control_tower_observation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'control tower observations are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS control_tower_observations_immutable_guard
  ON operations.control_tower_observations;

CREATE TRIGGER control_tower_observations_immutable_guard
BEFORE UPDATE OR DELETE ON operations.control_tower_observations
FOR EACH ROW
EXECUTE FUNCTION operations.reject_control_tower_observation_mutation();

CREATE TABLE IF NOT EXISTS operations.control_tower_action_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id BIGINT NOT NULL
    REFERENCES operations.control_tower_work_items(id) ON DELETE RESTRICT,
  action_code VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  requested_by VARCHAR(120) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  worker_id VARCHAR(120),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result_summary JSONB,
  error_code VARCHAR(100),
  error_message TEXT,
  source_audit_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_tower_action_attempts_status_chk
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT control_tower_action_attempts_attempt_chk
    CHECK (attempt_count >= 0),
  CONSTRAINT control_tower_action_attempts_json_chk
    CHECK (
      jsonb_typeof(request_payload) = 'object'
      AND jsonb_typeof(source_audit_refs) = 'array'
      AND (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object')
    )
);

CREATE INDEX IF NOT EXISTS idx_control_tower_action_attempts_item
  ON operations.control_tower_action_attempts (work_item_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_control_tower_action_attempts_pending
  ON operations.control_tower_action_attempts (requested_at, id)
  WHERE status IN ('pending', 'running');
