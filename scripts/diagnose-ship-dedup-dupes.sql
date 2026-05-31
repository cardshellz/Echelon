-- ===========================================================================
-- Diagnostic for migration 0570 failure:
--   could not create unique index "uq_inventory_transactions_ship_dedup"
--
-- READ-ONLY. Run against the database where 0570 failed (prod = Heroku
-- cardshellz-echelon, EXTERNAL_DATABASE_URL). Makes NO changes.
--
-- The intended invariant: one 'ship' transaction per (reference_id, order_item_id).
-- Existing rows violate it. Because recordShipment() decrements inventory_levels
-- AND writes the ledger row in ONE transaction (inventory.use-cases.ts:300-369),
-- a duplicate ledger row implies on-hand was decremented twice.
--
-- BUT reference_id falls back to order_id when shipment_id is NULL
-- (inventory.use-cases.ts:360), so groups that span multiple/NULL shipment_ids
-- may be LEGITIMATE partial shipments, not race duplicates. This script
-- separates the two cases so we don't delete real financial history.
-- ===========================================================================

-- 1) Headline: how many duplicate groups / extra rows are blocking the index?
SELECT
  COUNT(*)                              AS duplicate_groups,
  COALESCE(SUM(extra_rows), 0)          AS extra_rows_total
FROM (
  SELECT reference_id, order_item_id, COUNT(*) - 1 AS extra_rows
  FROM inventory.inventory_transactions
  WHERE transaction_type = 'ship'
    AND reference_id IS NOT NULL
    AND order_item_id IS NOT NULL
  GROUP BY reference_id, order_item_id
  HAVING COUNT(*) > 1
) g;

-- 2) Classify each duplicate group:
--    - 'race_duplicate'      : every row shares the SAME non-null shipment_id
--                              and the SAME variant_qty_delta  -> safe to collapse,
--                              represents a true double-write/double-decrement.
--    - 'ambiguous_partial'   : rows have differing or NULL shipment_id
--                              -> may be legitimate separate partial shipments.
SELECT
  CASE
    WHEN COUNT(DISTINCT shipment_id) = 1
         AND bool_and(shipment_id IS NOT NULL)
         AND COUNT(DISTINCT variant_qty_delta) = 1
      THEN 'race_duplicate'
    ELSE 'ambiguous_partial'
  END                                   AS classification,
  COUNT(*)                              AS groups,
  SUM(cnt - 1)                          AS extra_rows
FROM (
  SELECT reference_id, order_item_id,
         COUNT(*)                       AS cnt,
         COUNT(DISTINCT shipment_id)    AS distinct_shipments,
         bool_and(shipment_id IS NOT NULL) AS all_have_shipment,
         COUNT(DISTINCT variant_qty_delta) AS distinct_deltas,
         -- re-aggregate helpers for the outer CASE
         MAX(shipment_id)               AS shipment_id,
         MAX(variant_qty_delta)         AS variant_qty_delta
  FROM inventory.inventory_transactions
  WHERE transaction_type = 'ship'
    AND reference_id IS NOT NULL
    AND order_item_id IS NOT NULL
  GROUP BY reference_id, order_item_id
  HAVING COUNT(*) > 1
) per_group
GROUP BY 1;

-- 3) Detail of the worst 50 groups so we can eyeball them before any cleanup.
SELECT
  it.reference_id,
  it.order_item_id,
  COUNT(*)                              AS rows_in_group,
  COUNT(DISTINCT it.shipment_id)        AS distinct_shipment_ids,
  array_agg(it.id ORDER BY it.id)       AS txn_ids,
  array_agg(it.shipment_id ORDER BY it.id) AS shipment_ids,
  array_agg(it.variant_qty_delta ORDER BY it.id) AS deltas,
  array_agg(it.from_location_id ORDER BY it.id)  AS from_locations,
  array_agg(it.created_at ORDER BY it.id) AS created_ats,
  MIN(it.product_variant_id)            AS product_variant_id
FROM inventory.inventory_transactions it
WHERE it.transaction_type = 'ship'
  AND it.reference_id IS NOT NULL
  AND it.order_item_id IS NOT NULL
  AND (it.reference_id, it.order_item_id) IN (
    SELECT reference_id, order_item_id
    FROM inventory.inventory_transactions
    WHERE transaction_type = 'ship'
      AND reference_id IS NOT NULL
      AND order_item_id IS NOT NULL
    GROUP BY reference_id, order_item_id
    HAVING COUNT(*) > 1
  )
GROUP BY it.reference_id, it.order_item_id
ORDER BY rows_in_group DESC, it.reference_id
LIMIT 50;

-- 4) On-hand exposure: total base units that would need RE-CREDITING if every
--    "extra" race-duplicate row is a real double-decrement. (Negative deltas;
--    we report the absolute units that were over-removed.) This is the size of
--    the inventory_levels correction, NOT applied here.
SELECT
  COALESCE(SUM(ABS(extra_delta)), 0)    AS units_over_decremented_estimate
FROM (
  SELECT it.id,
         it.variant_qty_delta AS extra_delta,
         ROW_NUMBER() OVER (
           PARTITION BY it.reference_id, it.order_item_id
           ORDER BY it.id
         ) AS rn
  FROM inventory.inventory_transactions it
  WHERE it.transaction_type = 'ship'
    AND it.reference_id IS NOT NULL
    AND it.order_item_id IS NOT NULL
) ranked
WHERE rn > 1;
