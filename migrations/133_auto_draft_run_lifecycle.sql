-- Migration 133: Make auto-draft run ownership leased, single-flight, and auditable.

ALTER TABLE public.auto_draft_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP;

UPDATE public.auto_draft_runs
SET heartbeat_at = COALESCE(heartbeat_at, run_at);

ALTER TABLE public.auto_draft_runs
  ALTER COLUMN heartbeat_at SET DEFAULT NOW(),
  ALTER COLUMN heartbeat_at SET NOT NULL;

WITH ranked_running AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY run_at DESC, id DESC) AS run_rank
  FROM public.auto_draft_runs
  WHERE status = 'running'
)
UPDATE public.auto_draft_runs AS run
SET
  status = 'interrupted',
  finished_at = COALESCE(run.finished_at, NOW()),
  lease_expires_at = NULL,
  error_message = COALESCE(
    run.error_message,
    'Interrupted during lifecycle migration because a newer running auto-draft run exists.'
  )
FROM ranked_running AS ranked
WHERE run.id = ranked.id
  AND ranked.run_rank > 1;

UPDATE public.auto_draft_runs
SET
  finished_at = NULL,
  lease_expires_at = COALESCE(lease_expires_at, heartbeat_at + INTERVAL '30 minutes')
WHERE status = 'running';

UPDATE public.auto_draft_runs
SET
  finished_at = COALESCE(finished_at, run_at),
  lease_expires_at = NULL
WHERE status IN ('success', 'error', 'interrupted');

ALTER TABLE public.auto_draft_runs
  DROP CONSTRAINT IF EXISTS auto_draft_runs_status_chk,
  DROP CONSTRAINT IF EXISTS auto_draft_runs_lifecycle_chk;

ALTER TABLE public.auto_draft_runs
  ADD CONSTRAINT auto_draft_runs_status_chk
  CHECK (status IN ('running', 'success', 'error', 'interrupted')),
  ADD CONSTRAINT auto_draft_runs_lifecycle_chk
  CHECK (
    (
      status = 'running'
      AND finished_at IS NULL
      AND lease_expires_at IS NOT NULL
    ) OR (
      status <> 'running'
      AND finished_at IS NOT NULL
      AND lease_expires_at IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS auto_draft_runs_single_running_uidx
  ON public.auto_draft_runs (status)
  WHERE status = 'running';
