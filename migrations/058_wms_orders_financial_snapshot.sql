-- Migration: 058_wms_orders_financial_snapshot
-- Adds financial snapshot columns to wms.orders.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.1, §6 Group A Commit 2.
--
-- Purpose:
--   WMS becomes the source of truth for order-level financial totals that
--   ShipStation and downstream systems need. The OMS→WMS sync (landed in
--   Group B) will snapshot these values at creation time; WMS owns them
--   thereafter. This commit only adds the columns with safe zero defaults.
--   No data migration / backfill happens here.
--
-- Safety:
--   - Fully idempotent: every column uses ADD COLUMN IF NOT EXISTS.
--   - Zero data risk: no existing code reads these columns; defaults of
--     0 / 'USD' are inert until Group B sync writes real values.
--   - Reverse migration: migrations/reverse/058_wms_orders_financial_snapshot.sql
--     drops each column with DROP COLUMN IF EXISTS.
--   - Designed for Heroku release phase execution.

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS amount_paid_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS tax_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS shipping_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS discount_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS total_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'USD';
