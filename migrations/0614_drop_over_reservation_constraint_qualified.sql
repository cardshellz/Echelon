-- Re-run of migration 055's intent with a schema-qualified target.
--
-- 054 added chk_reserved_lte_onhand on inventory.inventory_levels. 055 was
-- meant to drop it (the replen engine deliberately relies on
-- reserved_qty > variant_qty — negative ATP against a bin — as its
-- backorder/auto-task signal), but its unqualified
-- `ALTER TABLE inventory_levels` resolved against the stray legacy
-- public.inventory_levels table (see the search_path note in server/db.ts),
-- so the DROP no-op'd and the constraint survived on the real table.
--
-- Result in production: every reservation attempt that would over-reserve
-- fails with SQLSTATE 23514, and the periodic reservation sweep re-attempts
-- the same doomed updates each cycle — a permanent error retried forever,
-- spamming the Postgres log (observed 2026-08-11).
ALTER TABLE inventory.inventory_levels
  DROP CONSTRAINT IF EXISTS chk_reserved_lte_onhand;
