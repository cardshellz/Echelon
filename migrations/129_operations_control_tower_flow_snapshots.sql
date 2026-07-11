BEGIN;

CREATE TABLE IF NOT EXISTS operations.control_tower_flow_snapshots (
  snapshot_key VARCHAR(80) PRIMARY KEY,
  window_days INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL,
  payload JSONB,
  started_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_tower_flow_snapshots_window_chk
    CHECK (window_days BETWEEN 1 AND 365),
  CONSTRAINT control_tower_flow_snapshots_status_chk
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT control_tower_flow_snapshots_duration_chk
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT control_tower_flow_snapshots_payload_chk
    CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  CONSTRAINT control_tower_flow_snapshots_completion_chk
    CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    ),
  CONSTRAINT control_tower_flow_snapshots_error_chk
    CHECK (
      (status = 'failed' AND error_message IS NOT NULL)
      OR (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_control_tower_flow_snapshots_generated
  ON operations.control_tower_flow_snapshots (generated_at DESC);

COMMIT;
