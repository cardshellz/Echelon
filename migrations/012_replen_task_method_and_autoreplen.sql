-- Add replen_method and auto_replen columns to replen_tasks
-- replen_method: persisted so executeTask knows whether to do case_break vs full_case
-- auto_replen: 1 = picker handles inline, 0 = worker queue task

ALTER TABLE replen_tasks
  ADD COLUMN IF NOT EXISTS replen_method VARCHAR(30) NOT NULL DEFAULT 'full_case',
  ADD COLUMN IF NOT EXISTS auto_replen INTEGER NOT NULL DEFAULT 0;

-- Backfill existing tasks: try to derive replen_method from linked rule
UPDATE replen_tasks rt
SET replen_method = rr.replen_method
FROM replen_rules rr
WHERE rt.replen_rule_id = rr.id
  AND rr.replen_method IS NOT NULL;

-- Backfill auto_replen from linked rule
UPDATE replen_tasks rt
SET auto_replen = rr.auto_replen
FROM replen_rules rr
WHERE rt.replen_rule_id = rr.id
  AND rr.auto_replen IS NOT NULL;
