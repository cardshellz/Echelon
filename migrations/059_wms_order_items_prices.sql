-- Migration 059: wms.order_items price columns.
--
-- Plan ref: shipstation-flow-refactor-plan.md §4.2 + §6 Group A C3.
--
-- Adds per-line price columns to wms.order_items so ShipStation push
-- (Group C, Commit 11) can read prices from WMS instead of OMS — this
-- closes audit bug B1 at the data layer (SS lines shipped with $0.00
-- unitPrice because pushOrder read a non-existent `priceCents` column
-- on oms_order_lines; actual columns are paidPriceCents / totalPriceCents).
--
-- Columns added (BIGINT NOT NULL DEFAULT 0):
--   unit_price_cents   — per-unit paid price (what SS expects as
--                        `unitPrice` on each line). Snapshotted from
--                        OMS oms_order_lines.paid_price_cents.
--   paid_price_cents   — mirror of OMS paid_price_cents for audit.
--   total_price_cents  — OMS total_price_cents (line extended total).
--
-- Zero defaults are safe: existing rows will have 0 until backfill
-- (commit 33), but no code reads these until Group B+C lands (flag-gated).
--
-- Rollback: migrations/reverse/059_wms_order_items_prices.sql.
-- Idempotent: IF NOT EXISTS throughout.

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS unit_price_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.order_items.unit_price_cents IS
  'Per-unit paid price (what the customer actually paid per unit after discounts). Integer cents; sourced from OMS oms_order_lines.paid_price_cents at sync time. SS push reads this as line.unitPrice.';

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS paid_price_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.order_items.paid_price_cents IS
  'Per-unit paid price snapshot (mirror of OMS paid_price_cents for audit / partial-refund support). Integer cents.';

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS total_price_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.order_items.total_price_cents IS
  'Line extended total (unit_price × quantity, pre-computed by OMS). Integer cents. Used by push-validation to reconcile against order header total.';
