-- 219: inventory.inventory_lots.packaging_cost_cents -> bigint.
--
-- Migration 0576 (2026-06-01) aligned every money column on this table to
-- bigint. Migration 098 created packaging_cost_cents as NUMERIC(10,4) one day
-- later, so it was never covered and has been the table's only non-bigint cost
-- column since.
--
-- Postgres pads a numeric to its declared scale on the wire, so this column
-- read back as "0.0000" while every sibling read back as "0". BigInt() rejects
-- any string carrying a decimal point, so the FIFO lot cost normalizer threw
-- "packaging_cost_cents is not an integer mill value" on a value that was
-- simply zero. From 2026-09-04 (commit ce8e8785) that normalizer runs on the
-- transfer and negative-adjustment paths, which broke inventory transfers,
-- replenishment moves, case breaks and cycle-count moves in production.
--
-- The column has only ever held whole cents: every writer rounds through
-- millsToCents() or buildMillsToRoundedCents(), and sub-cent precision lives in
-- packaging_cost_mills. Production confirmed 0 fractional rows and 0 rows
-- carrying cents without matching mills across all 2227 lots, so round() below
-- is a no-op safety net rather than a data change.
--
-- Guarded so it is a no-op against a database that already has bigint, and
-- the default is dropped and restored explicitly rather than relying on an
-- implicit cast of the default expression.

BEGIN;

DO $$
DECLARE
  current_type text;
BEGIN
  SELECT data_type INTO current_type
  FROM information_schema.columns
  WHERE table_schema = 'inventory'
    AND table_name = 'inventory_lots'
    AND column_name = 'packaging_cost_cents';

  IF current_type IS NULL THEN
    RAISE NOTICE '219: inventory.inventory_lots.packaging_cost_cents is absent, nothing to align';
    RETURN;
  END IF;

  IF current_type = 'bigint' THEN
    RAISE NOTICE '219: inventory.inventory_lots.packaging_cost_cents is already bigint';
    RETURN;
  END IF;

  ALTER TABLE inventory.inventory_lots
    ALTER COLUMN packaging_cost_cents DROP DEFAULT;

  ALTER TABLE inventory.inventory_lots
    ALTER COLUMN packaging_cost_cents TYPE bigint
    USING round(packaging_cost_cents::numeric);

  ALTER TABLE inventory.inventory_lots
    ALTER COLUMN packaging_cost_cents SET DEFAULT 0;

  RAISE NOTICE '219: converted inventory.inventory_lots.packaging_cost_cents from % to bigint', current_type;
END $$;

COMMIT;
