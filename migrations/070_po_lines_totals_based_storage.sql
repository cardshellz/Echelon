-- Migration 070: PO line totals-based cost storage (Spec F Phase 1)
--
-- Adds total_product_cost_cents and packaging_cost_cents as the new source
-- of truth for PO line cost. Existing unit_cost_mills / unit_cost_cents
-- columns stay (now computed-derived); they'll be dropped in Phase F5.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + backfill WHERE total_product_cost_cents = 0.

-- New columns
ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS total_product_cost_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS packaging_cost_cents bigint NOT NULL DEFAULT 0;

-- Backfill from existing data (best-effort).
-- Existing data uses unit_cost_mills as source of truth.
-- line_total_cents = round_half_up(unit_cost_mills * order_qty / 100)
-- So: total_product_cost_cents = round(unit_cost_mills * order_qty / 100.0)
--     (packaging_cost_cents = 0 for all existing rows — we can't distinguish)
--
-- IMPORTANT: 1 cent = 100 mills (verified in shared/utils/money.ts:
--   centsToMills = cents * 100, millsToCents = roundHalfUp(mills, 100)).
-- The spec draft used /10 which was incorrect; corrected to /100 here.
UPDATE procurement.purchase_order_lines
SET total_product_cost_cents = ROUND(
    COALESCE(unit_cost_mills, unit_cost_cents * 100) * order_qty / 100.0
  )::bigint
WHERE total_product_cost_cents = 0
  AND order_qty > 0;
