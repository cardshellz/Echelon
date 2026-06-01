-- Phase 3: Reservation integrity fixes
--
-- 1. Unique partial index on reserve transactions to prevent double-reserving
--    the same order item. Mirrors the ship dedup pattern (migration 0570).
--
-- 2. Partial index on warehouse_locations for unfrozen bins, used by the
--    reservation fallback query to skip frozen locations efficiently.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RESERVE DEDUP — one 'reserve' ledger row per (order_id, order_item_id)
-- ═══════════════════════════════════════════════════════════════════════════

-- Pre-flight: detect existing duplicates so we don't fail opaquely.
DO $$
DECLARE
  dup_groups integer;
  sample text;
BEGIN
  SELECT COUNT(*),
         COALESCE(
           string_agg(
             format('(order=%s, item=%s, rows=%s)', order_id, order_item_id, cnt),
             ', ' ORDER BY cnt DESC
           ),
           ''
         )
    INTO dup_groups, sample
  FROM (
    SELECT order_id, order_item_id, COUNT(*) AS cnt
    FROM inventory.inventory_transactions
    WHERE transaction_type = 'reserve'
      AND order_id IS NOT NULL
      AND order_item_id IS NOT NULL
      AND voided_at IS NULL
    GROUP BY order_id, order_item_id
    HAVING COUNT(*) > 1
    LIMIT 25
  ) d;

  IF dup_groups > 0 THEN
    RAISE WARNING
      'reserve_dedup preflight: % order/item group(s) have duplicate reserve rows. '
      'Voiding duplicates (keeping earliest). Sample: %', dup_groups, sample;

    -- Void all but the earliest reserve per (order_id, order_item_id)
    UPDATE inventory.inventory_transactions it
    SET voided_at = NOW()
    WHERE it.id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY order_id, order_item_id
                 ORDER BY id ASC
               ) AS rn
        FROM inventory.inventory_transactions
        WHERE transaction_type = 'reserve'
          AND order_id IS NOT NULL
          AND order_item_id IS NOT NULL
          AND voided_at IS NULL
      ) ranked
      WHERE ranked.rn > 1
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_reserve_dedup
  ON inventory.inventory_transactions (order_id, order_item_id)
  WHERE transaction_type = 'reserve'
    AND order_id IS NOT NULL
    AND order_item_id IS NOT NULL
    AND voided_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. FREEZE-AWARE INDEX for reservation bin lookup
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_warehouse_locations_unfrozen
  ON warehouse.warehouse_locations (id)
  WHERE cycle_count_freeze_id IS NULL;
