-- 218: Restore the primary flag on stranded pick slots.
--
-- Until 2026-05-14 (commit 0faaa645) the slot writer cleared is_primary on every
-- row of a PRODUCT whenever a new variant of that product was slotted, then
-- flagged only the new variant. Sibling pack sizes slotted earlier kept their
-- bin but lost the flag, and nothing since restored it. Separately, rows created
-- by the Shopify product webhook carry the default flag but point at no bin.
-- The OMS->WMS sync required the flag and stamped UNASSIGNED on every order line
-- of such variants (SHLZ-MAG-STND-P5, ARM-ENV-GRD-C60, ARM-ENV-GRD-P10; 2026-09).
--
-- Idempotent data repair in three steps, all scoped to variant-linked rows:
--   1. demote flagged placeholder rows (no bin) whose variant also has a
--      bin-backed row, so a placeholder can never shadow a real slot;
--   2. flag the bin-backed active row of every variant that has exactly one
--      and none flagged. Variants with several unflagged bin-backed rows are
--      ambiguous and are deliberately left to the integrity audit
--      (variant_slot_without_primary_pick_bin) and Slotting Setup;
--   3. re-stamp still-open, unpicked, UNASSIGNED order lines for the SKUs
--      repaired in step 2 — the same rule as backfillUnassignedWmsOrderItemBin,
--      so the pick gun updates at deploy instead of waiting for a re-save.
--
-- Re-running is a no-op (every step's predicate is false after the first run).
-- Counts are emitted as NOTICEs for the release log.

BEGIN;

DO $$
DECLARE
  demoted_placeholders integer := 0;
  promoted_slots integer := 0;
  restamped_lines integer := 0;
BEGIN
  -- Step 1: placeholders must not hold the flag while a real slot exists.
  WITH placeholder AS (
    SELECT pl.id
    FROM warehouse.product_locations pl
    WHERE pl.product_variant_id IS NOT NULL
      AND pl.warehouse_location_id IS NULL
      AND pl.is_primary = 1
      AND EXISTS (
        SELECT 1
        FROM warehouse.product_locations real_slot
        WHERE real_slot.product_variant_id = pl.product_variant_id
          AND real_slot.warehouse_location_id IS NOT NULL
      )
  ),
  demoted AS (
    UPDATE warehouse.product_locations pl
    SET is_primary = 0, updated_at = NOW()
    FROM placeholder
    WHERE pl.id = placeholder.id
    RETURNING pl.id
  )
  SELECT COUNT(*) INTO demoted_placeholders FROM demoted;

  -- Step 2: the single bin-backed active slot of a variant is its primary.
  CREATE TEMP TABLE repaired_slots (
    product_location_id integer PRIMARY KEY,
    sku text,
    location_code text NOT NULL,
    zone text NOT NULL
  ) ON COMMIT DROP;

  WITH stranded AS (
    SELECT pl.product_variant_id
    FROM warehouse.product_locations pl
    WHERE pl.product_variant_id IS NOT NULL
      AND pl.status = 'active'
      AND pl.warehouse_location_id IS NOT NULL
    GROUP BY pl.product_variant_id
    HAVING COUNT(*) = 1
       AND COUNT(*) FILTER (WHERE pl.is_primary = 1) = 0
  ),
  promoted AS (
    UPDATE warehouse.product_locations pl
    SET is_primary = 1, updated_at = NOW()
    FROM stranded
    WHERE pl.product_variant_id = stranded.product_variant_id
      AND pl.status = 'active'
      AND pl.warehouse_location_id IS NOT NULL
    RETURNING pl.id, pl.sku, pl.location, pl.zone, pl.warehouse_location_id
  )
  INSERT INTO repaired_slots (product_location_id, sku, location_code, zone)
  SELECT
    p.id,
    UPPER(p.sku),
    UPPER(COALESCE(wl.code, p.location)),
    UPPER(COALESCE(wl.zone, p.zone, 'U'))
  FROM promoted p
  LEFT JOIN warehouse.warehouse_locations wl ON wl.id = p.warehouse_location_id;

  SELECT COUNT(*) INTO promoted_slots FROM repaired_slots;

  -- Step 3: open, unpicked, still-UNASSIGNED lines of the repaired SKUs get the bin.
  WITH restamped AS (
    UPDATE wms.order_items oi
    SET location = rs.location_code, zone = rs.zone
    FROM repaired_slots rs, wms.orders o
    WHERE o.id = oi.order_id
      AND rs.sku IS NOT NULL
      AND UPPER(oi.sku) = rs.sku
      AND (oi.location IS NULL OR oi.location IN ('UNASSIGNED', 'U'))
      AND oi.picked_quantity < oi.quantity
      AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')
    RETURNING oi.id
  )
  SELECT COUNT(*) INTO restamped_lines FROM restamped;

  RAISE NOTICE '218 product_locations repair: demoted % placeholder slot(s), promoted % stranded slot(s), re-stamped % open order line(s)',
    demoted_placeholders, promoted_slots, restamped_lines;
END $$;

COMMIT;
