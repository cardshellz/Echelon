-- Replenishment reasons are descriptive provenance, not fixed-width codes.
-- The picker already emits pick_shortage_case_break (24 characters). Keep the
-- complete reason, existing default, and NOT NULL contract without a length cap.
ALTER TABLE inventory.replen_tasks
  ALTER COLUMN triggered_by TYPE text;
