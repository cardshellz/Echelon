-- Migration 094: COGS Phase 1 — schema foundation + ledger unification
--
-- Context (grounded in code review):
--   * The LIVE COGS ledger is oms.order_item_costs, written at pick time by
--     InventoryLotService.pickFromLots (lots.service.ts).
--   * inventory.order_line_costs is a DEAD parallel ledger (0 rows in prod):
--     its only writer, COGSService.recordShipmentCOGS, ran at ship time after
--     pick had already moved units into qty_picked, so consumeLotsFIFO (which
--     only sees un-picked on-hand) found nothing to record. That writer is
--     removed in this phase; the two API readers (getOrderCOGS,
--     getAffectedOrdersForLot) now read oms.order_item_costs.
--
-- This migration:
--   1. Adds referential integrity on oms.order_item_costs.inventory_lot_id.
--      Added NOT VALID so any pre-existing orphan rows do not block the
--      migration; the constraint is enforced for all new/updated rows.
--   2. Marks the retired order_line_costs table as deprecated (kept empty for
--      a soak period, consistent with the project's legacy-column convention;
--      drop is a post-soak TODO).
--
-- No data is mutated. No idempotency/unique constraint is added here: a single
-- order_item can legitimately consume the same lot across two separate partial
-- picks, so (order_item_id, inventory_lot_id) is NOT unique. Pick idempotency
-- is handled in COGS Phase 4 with an explicit pick-event key.

-- 1. Referential integrity: every COGS row must point at a real lot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'oms'
      AND table_name = 'order_item_costs'
      AND constraint_name = 'order_item_costs_inventory_lot_id_fkey'
  ) THEN
    ALTER TABLE oms.order_item_costs
      ADD CONSTRAINT order_item_costs_inventory_lot_id_fkey
      FOREIGN KEY (inventory_lot_id)
      REFERENCES inventory.inventory_lots (id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

-- 2. Deprecate the dead ledger (kept empty for soak; dropped post-soak).
--    Guarded: the table may live in inventory or public depending on how the
--    startup DDL (server/db.ts) created it; comment only if it exists.
DO $$
DECLARE
  tbl regclass := COALESCE(
    to_regclass('inventory.order_line_costs'),
    to_regclass('public.order_line_costs')
  );
BEGIN
  IF tbl IS NOT NULL THEN
    EXECUTE format(
      'COMMENT ON TABLE %s IS %L',
      tbl,
      'DEPRECATED (COGS Phase 1, migration 094). Retired in favor of oms.order_item_costs (written at pick time). No code reads or writes this table. Safe to DROP after soak.'
    );
  END IF;
END $$;
