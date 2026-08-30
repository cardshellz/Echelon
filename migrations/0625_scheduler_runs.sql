-- Durable record of when each scheduled sweep last completed.
--
-- The background sweeps ran a catch-up pass on every boot. That is correct after
-- real downtime and wasteful otherwise, and Echelon deploys many times a day, so
-- the catch-up fired constantly against an app that had been up seconds earlier.
-- Several heavy sweeps allocating at once on a 512MB dyno is the shape behind the
-- 1.4GB peak and the R14/R15/H10 crash loop on 2026-08-28.
--
-- The existing scheduler heartbeats are module-level variables, so a restart
-- erases them and every boot looks like a cold start. This table survives the
-- restart, letting a boot ask the only question that matters: are we behind?
--
-- Lives in public, not oms: ARCHITECTURE-AUDIT-2026-07.md 4.1 makes modules/oms
-- the sole writer of oms.*, and this is cross-cutting scheduler bookkeeping that
-- any module may need. Same placement as public.audit_events, the other
-- infrastructure-owned table.
--
-- Keyed by job, one row per sweep. Primary key gives ON CONFLICT its target.
CREATE TABLE IF NOT EXISTS public.scheduler_runs (
  job_key VARCHAR(100) PRIMARY KEY,
  last_completed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.scheduler_runs IS
  'Last successful completion per scheduled sweep. Read on boot to decide whether a catch-up pass is genuinely needed.';
