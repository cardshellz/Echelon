-- Reverse migration: 059_wms_order_items_prices
-- Drops the per-line price columns added to wms.order_items by
-- migrations/059_wms_order_items_prices.sql.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.2, §6 Group A Commit 3.
--
-- Safety:
--   - Idempotent: every column uses DROP COLUMN IF EXISTS.
--   - Data loss on rollback is acceptable *at this stage* — no sync code
--     writes these columns until Group B lands. Values will be defaults
--     (0). Running this AFTER Group B lands WILL destroy real per-line
--     price snapshots that the ShipStation push depends on; do not
--     execute in production post–Group B without a backfill plan
--     (re-derive from oms.oms_order_lines via oms_order_line_id).

ALTER TABLE wms.order_items
  DROP COLUMN IF EXISTS unit_price_cents;

ALTER TABLE wms.order_items
  DROP COLUMN IF EXISTS paid_price_cents;

ALTER TABLE wms.order_items
  DROP COLUMN IF EXISTS total_price_cents;
