-- Migration 064: NOT VALID check constraint on wms.orders.oms_fulfillment_order_id
--
-- Plan ref: shipstation-flow-refactor-plan.md §6 Commit 32.
--
-- Purpose: enforce "every new wms.orders row has an OMS parent" at the
-- DB level as a backstop for the C9 application-level invariant in
-- insertWmsOrder (server/modules/wms/insert-order.ts). After C31's
-- backfill closes the recoverable data gap, ~33,813 truly-orphaned
-- legacy rows remain with NULL oms_fulfillment_order_id. Those are
-- pre-OMS-migration data that cannot be repaired. We accept them but
-- block any new NULL writes from this point forward.
--
-- Why NOT VALID instead of plain NOT NULL:
--   Plain ALTER COLUMN SET NOT NULL would validate ALL existing rows
--   and fail the migration if any are still NULL. NOT VALID adds the
--   constraint for future writes only; legacy NULLs pass through. We
--   accept this asymmetry because the legacy NULLs are unfixable
--   orphans and blocking the migration on them would be backwards.
--
-- Safety:
--   - Idempotent: DROP IF EXISTS then ADD
--   - Zero data risk: no rows modified
--   - Future protection: any INSERT/UPDATE that would set this column
--     to NULL fails at the DB level
--   - Rollback: reverse migration drops the constraint
--
-- We are NOT converting NOT VALID to VALID via ALTER TABLE ... VALIDATE
-- CONSTRAINT. Doing so would force-validate the legacy NULLs and fail.
-- If at some future date the orphans are cleaned up via a separate
-- workflow, a follow-up migration can promote the constraint to VALID.

-- Drop first if exists (idempotent re-run safety)
ALTER TABLE wms.orders
  DROP CONSTRAINT IF EXISTS chk_oms_fulfillment_order_id_not_null;

-- Add NOT VALID check constraint
ALTER TABLE wms.orders
  ADD CONSTRAINT chk_oms_fulfillment_order_id_not_null
    CHECK (oms_fulfillment_order_id IS NOT NULL)
    NOT VALID;
