-- Reverse migration: 058_wms_orders_financial_snapshot
-- Drops the financial snapshot columns added to wms.orders by
-- migrations/058_wms_orders_financial_snapshot.sql.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.1, §6 Group A Commit 2.
--
-- Safety:
--   - Idempotent: every column uses DROP COLUMN IF EXISTS.
--   - Data loss on rollback is acceptable at this stage — no sync code
--     writes these columns until Group B lands. Values will be defaults
--     (0 / 'USD'). Running this after Group B lands WILL destroy real
--     financial snapshots; do not execute in production post–Group B
--     without backfill plan.

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS amount_paid_cents;

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS tax_cents;

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS shipping_cents;

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS discount_cents;

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS total_cents;

ALTER TABLE wms.orders
  DROP COLUMN IF EXISTS currency;
