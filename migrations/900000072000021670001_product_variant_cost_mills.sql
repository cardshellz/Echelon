-- Add 4-decimal mills cost columns (1 USD = 10,000 mills; 1 cent = 100 mills)
-- to catalog.product_variants so sub-half-cent items (< $0.0050, e.g. $0.0038
-- penny sleeves = 38 mills) do not round to 0 cents in fallback cost resolution,
-- and backfill existing variants from active FIFO lots / cent mirrors.

ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS standard_cost_mills BIGINT,
  ADD COLUMN IF NOT EXISTS last_cost_mills BIGINT,
  ADD COLUMN IF NOT EXISTS avg_cost_mills BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_standard_cost_mills_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_standard_cost_mills_chk
      CHECK (standard_cost_mills IS NULL OR standard_cost_mills >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_last_cost_mills_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_last_cost_mills_chk
      CHECK (last_cost_mills IS NULL OR last_cost_mills >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_avg_cost_mills_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_avg_cost_mills_chk
      CHECK (avg_cost_mills IS NULL OR avg_cost_mills >= 0);
  END IF;
END $$;

-- 1. Backfill standard_cost_mills from standard_cost_cents when present.
UPDATE catalog.product_variants
SET standard_cost_mills = standard_cost_cents * 100
WHERE standard_cost_mills IS NULL
  AND standard_cost_cents IS NOT NULL
  AND standard_cost_cents >= 0;

-- 2. Backfill avg_cost_mills (and repair avg_cost_cents) from active on-hand FIFO lots
--    when available, otherwise from existing avg_cost_cents.
WITH active_lot_rollups AS (
  SELECT
    il.product_variant_id,
    SUM(il.qty_on_hand)::bigint AS total_qty,
    SUM(
      il.qty_on_hand::bigint * GREATEST(
        0::bigint,
        COALESCE(
          il.total_unit_cost_mills,
          il.unit_cost_mills,
          COALESCE(il.unit_cost_cents, 0)::bigint * 100
        )
      )
    )::bigint AS total_cost_mills
  FROM inventory.inventory_lots il
  WHERE il.status = 'active'
    AND il.qty_on_hand > 0
  GROUP BY il.product_variant_id
)
UPDATE catalog.product_variants pv
SET avg_cost_mills = ((r.total_cost_mills * 2 + r.total_qty) / (r.total_qty * 2)),
    avg_cost_cents = ((((r.total_cost_mills * 2 + r.total_qty) / (r.total_qty * 2)) + 50) / 100)
FROM active_lot_rollups r
WHERE pv.id = r.product_variant_id
  AND r.total_qty > 0;

UPDATE catalog.product_variants
SET avg_cost_mills = avg_cost_cents * 100
WHERE avg_cost_mills IS NULL
  AND avg_cost_cents IS NOT NULL
  AND avg_cost_cents >= 0;

-- 3. Backfill last_cost_mills (and repair last_cost_cents where previously wiped to 0
--    by package conversions) from the latest positive-cost FIFO lot, falling back to
--    existing last_cost_cents.
WITH latest_positive_lot AS (
  SELECT DISTINCT ON (il.product_variant_id)
    il.product_variant_id,
    GREATEST(
      0::bigint,
      COALESCE(
        il.total_unit_cost_mills,
        il.unit_cost_mills,
        COALESCE(il.unit_cost_cents, 0)::bigint * 100
      )
    ) AS unit_mills
  FROM inventory.inventory_lots il
  WHERE GREATEST(
      0::bigint,
      COALESCE(
        il.total_unit_cost_mills,
        il.unit_cost_mills,
        COALESCE(il.unit_cost_cents, 0)::bigint * 100
      )
    ) > 0
  ORDER BY il.product_variant_id, il.received_at DESC NULLS LAST, il.id DESC
)
UPDATE catalog.product_variants pv
SET last_cost_mills = l.unit_mills,
    last_cost_cents = ((l.unit_mills + 50) / 100)
FROM latest_positive_lot l
WHERE pv.id = l.product_variant_id
  AND (pv.last_cost_mills IS NULL OR COALESCE(pv.last_cost_cents, 0) = 0);

UPDATE catalog.product_variants
SET last_cost_mills = last_cost_cents * 100
WHERE last_cost_mills IS NULL
  AND last_cost_cents IS NOT NULL
  AND last_cost_cents >= 0;
