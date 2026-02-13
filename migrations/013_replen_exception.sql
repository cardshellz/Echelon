-- Migration 013: Add exception fields to replen_tasks for cycle count integration
-- When a worker finds a discrepancy during replen execution, the task gets blocked
-- and a cycle count is auto-created for the affected location.

ALTER TABLE replen_tasks ADD COLUMN exception_reason VARCHAR(30);
ALTER TABLE replen_tasks ADD COLUMN linked_cycle_count_id INTEGER REFERENCES cycle_counts(id);
