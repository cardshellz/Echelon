-- Migration 031: Cycle count soft-freeze on warehouse locations + resolve fields
-- When a cycle count is initialized, set cycle_count_freeze_id on all
-- in-scope locations. Reservations, picks, and replenishments skip
-- frozen locations. Cleared on complete/delete/cancel.

ALTER TABLE warehouse_locations
  ADD COLUMN IF NOT EXISTS cycle_count_freeze_id INTEGER
    REFERENCES cycle_counts(id) ON DELETE SET NULL;

-- Partial index: only indexes non-null values (tiny index since most locations are unfrozen)
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_freeze
  ON warehouse_locations (cycle_count_freeze_id)
  WHERE cycle_count_freeze_id IS NOT NULL;

-- Resolve fields on cycle count items (for closing without inventory adjustment)
ALTER TABLE cycle_count_items
  ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
