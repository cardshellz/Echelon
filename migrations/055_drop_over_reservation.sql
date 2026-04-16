-- Migration: Drop CHECK constraint that prevents negative available allocation (over-reservation)
-- Echelon's replen engine relies on negative variantQty - reservedQty (which is ATP against empty bins) to trigger auto-tasks!

ALTER TABLE inventory_levels DROP CONSTRAINT IF EXISTS chk_reserved_lte_onhand;
