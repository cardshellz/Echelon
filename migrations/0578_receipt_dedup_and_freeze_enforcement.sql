-- Phase 4: Receipt integrity + freeze enforcement
--
-- 1. Receipt dedup unique index — one 'receipt' ledger row per
--    (receiving_order_id, product_variant_id, to_location_id).
--    Mirrors the ship dedup pattern (migration 0570) and reserve dedup (0577).
--
-- 2. Startup db.ts handles the index for deploys; this migration handles
--    the one-time preflight + duplicate cleanup.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RECEIPT DEDUP
-- ═══════════════════════════════════════════════════════════════════════════

-- Pre-flight: detect existing duplicate receipt rows.
DO $$
DECLARE
  dup_groups integer;
  sample text;
BEGIN
  SELECT COUNT(*),
         COALESCE(
           string_agg(
             format('(rcv_order=%s, variant=%s, loc=%s, rows=%s)',
                    receiving_order_id, product_variant_id, to_location_id, cnt),
             ', ' ORDER BY cnt DESC
           ),
           ''
         )
    INTO dup_groups, sample
  FROM (
    SELECT receiving_order_id, product_variant_id, to_location_id, COUNT(*) AS cnt
    FROM inventory.inventory_transactions
    WHERE transaction_type = 'receipt'
      AND receiving_order_id IS NOT NULL
      AND product_variant_id IS NOT NULL
      AND to_location_id IS NOT NULL
      AND voided_at IS NULL
    GROUP BY receiving_order_id, product_variant_id, to_location_id
    HAVING COUNT(*) > 1
    LIMIT 25
  ) d;

  IF dup_groups > 0 THEN
    RAISE WARNING
      'receipt_dedup preflight: % group(s) have duplicate receipt rows. '
      'Voiding duplicates (keeping earliest). Sample: %', dup_groups, sample;

    UPDATE inventory.inventory_transactions it
    SET voided_at = NOW()
    WHERE it.id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY receiving_order_id, product_variant_id, to_location_id
                 ORDER BY id ASC
               ) AS rn
        FROM inventory.inventory_transactions
        WHERE transaction_type = 'receipt'
          AND receiving_order_id IS NOT NULL
          AND product_variant_id IS NOT NULL
          AND to_location_id IS NOT NULL
          AND voided_at IS NULL
      ) ranked
      WHERE ranked.rn > 1
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_dedup
  ON inventory.inventory_transactions (receiving_order_id, product_variant_id, to_location_id)
  WHERE transaction_type = 'receipt'
    AND receiving_order_id IS NOT NULL
    AND product_variant_id IS NOT NULL
    AND to_location_id IS NOT NULL
    AND voided_at IS NULL;
