CREATE TABLE IF NOT EXISTS procurement.purchase_pipeline_job_runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type VARCHAR(40) NOT NULL,
  trigger_type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  recommendation_run_id INTEGER
    REFERENCES procurement.purchase_recommendation_runs(id) ON DELETE RESTRICT,
  recommendation_line_count INTEGER,
  forecast_observation_count INTEGER,
  evaluation_inserted_count INTEGER,
  evaluation_batch_count INTEGER,
  evaluation_backlog_may_remain BOOLEAN,
  result_json JSONB,
  error_code VARCHAR(100),
  error_message VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT purchase_pipeline_job_runs_job_type_chk CHECK (
    job_type IN ('recommendation_snapshot', 'forecast_evaluation')
  ),
  CONSTRAINT purchase_pipeline_job_runs_trigger_type_chk CHECK (
    trigger_type IN ('scheduled', 'manual')
  ),
  CONSTRAINT purchase_pipeline_job_runs_status_chk CHECK (
    status IN ('running', 'succeeded', 'failed', 'interrupted')
  ),
  CONSTRAINT purchase_pipeline_job_runs_lifecycle_chk CHECK (
    (
      status = 'running'
      AND finished_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR (
      status = 'succeeded'
      AND finished_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR (
      status IN ('failed', 'interrupted')
      AND finished_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND error_code IS NOT NULL
      AND BTRIM(error_code) <> ''
      AND error_message IS NOT NULL
      AND BTRIM(error_message) <> ''
    )
  ),
  CONSTRAINT purchase_pipeline_job_runs_time_chk CHECK (
    heartbeat_at >= started_at
    AND (lease_expires_at IS NULL OR lease_expires_at > heartbeat_at)
    AND (finished_at IS NULL OR finished_at >= started_at)
  ),
  CONSTRAINT purchase_pipeline_job_runs_counts_chk CHECK (
    (recommendation_line_count IS NULL OR recommendation_line_count >= 0)
    AND (forecast_observation_count IS NULL OR forecast_observation_count >= 0)
    AND (evaluation_inserted_count IS NULL OR evaluation_inserted_count >= 0)
    AND (evaluation_batch_count IS NULL OR evaluation_batch_count >= 0)
  ),
  CONSTRAINT purchase_pipeline_job_runs_success_result_chk CHECK (
    status <> 'succeeded'
    OR (
      job_type = 'recommendation_snapshot'
      AND recommendation_run_id IS NOT NULL
      AND recommendation_line_count IS NOT NULL
      AND forecast_observation_count IS NOT NULL
      AND evaluation_inserted_count IS NULL
      AND evaluation_batch_count IS NULL
      AND evaluation_backlog_may_remain IS NULL
      AND result_json IS NOT NULL
      AND jsonb_typeof(result_json) = 'object'
    )
    OR (
      job_type = 'forecast_evaluation'
      AND recommendation_run_id IS NULL
      AND recommendation_line_count IS NULL
      AND forecast_observation_count IS NULL
      AND evaluation_inserted_count IS NOT NULL
      AND evaluation_batch_count IS NOT NULL
      AND evaluation_backlog_may_remain IS NOT NULL
      AND result_json IS NOT NULL
      AND jsonb_typeof(result_json) = 'object'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_pipeline_job_runs_single_running_uidx
  ON procurement.purchase_pipeline_job_runs(job_type)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS purchase_pipeline_job_runs_latest_idx
  ON procurement.purchase_pipeline_job_runs(job_type, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS purchase_pipeline_job_runs_recommendation_run_idx
  ON procurement.purchase_pipeline_job_runs(recommendation_run_id)
  WHERE recommendation_run_id IS NOT NULL;

COMMENT ON TABLE procurement.purchase_pipeline_job_runs IS
  'Durable execution evidence for scheduled and manual purchase recommendation snapshot and forecast evaluation jobs.';
