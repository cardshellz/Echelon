-- outbound_shipment_hold_flags
--
-- wms.outbound_shipments.held and held_at (the shipment-level hold flag,
-- SHIPMENT-STATE-MACHINE-DESIGN.md Phase 1a) have never had a tracked
-- migration. They exist in production only because the legacy schema
-- fallbacks in server/db.ts added them at application boot. This migration
-- gives them a tracked home so that fallback block can be deleted
-- (REFACTOR-PLAN-2026-07.md, P4.1).
--
-- Production already has both columns with exactly these definitions, so this
-- changes nothing there. Each column is added only when it is missing: the
-- check reads the catalog and takes no lock on the table, so on a database
-- that already has the columns (production) this migration never queues
-- behind, or in front of, live queries on wms.outbound_shipments.
--
-- No data is written. `held` defaults to false, which is the "not held" state
-- every existing row would already have.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'wms'
      AND table_name = 'outbound_shipments'
      AND column_name = 'held'
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD COLUMN held boolean NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'wms'
      AND table_name = 'outbound_shipments'
      AND column_name = 'held_at'
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD COLUMN held_at timestamp without time zone;
  END IF;
END $$;
