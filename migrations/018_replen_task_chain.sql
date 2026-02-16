-- Migration 018: Add depends_on_task_id for chained replen tasks
-- When a cascade break is needed (e.g., Case→Box must complete before Box→Pack),
-- the downstream task is blocked with depends_on_task_id pointing to the upstream task.

ALTER TABLE replen_tasks ADD COLUMN IF NOT EXISTS depends_on_task_id INTEGER;
