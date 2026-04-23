-- Migration 058: wms.orders financial snapshot columns.
--
-- Plan ref: shipstation-flow-refactor-plan.md §4.1 + §6 Group A C2.
--
-- Adds integer-cents financial columns to wms.orders so WMS owns the
-- snapshot of the order's financials at sync time (invariant #2: "WMS is
-- the sole source of truth for fulfillment"). OMS→WMS sync (Group B)
-- will populate these; ShipStation push (Group C) will read them.
--
-- Defaults are safe: 0 cents + 'USD'. Existing rows are unaffected by
-- behavior — later Group B code paths are feature-flag-gated, so the
-- columns stay at defaults until the flag flips. Push / ship-notify /
-- reconcile code does NOT read these columns yet.
--
-- Idempotent: every ALTER uses IF NOT EXISTS. Safe to re-run.
--
-- Rollback: migrations/reverse/058_wms_orders_financial_snapshot.sql
--   (drop columns). Safe because no code reads them pre-Group-B flip.

-- ---------------------------------------------------------------------
-- Financial snapshot columns (§4.1)
-- ---------------------------------------------------------------------

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS amount_paid_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.orders.amount_paid_cents IS
  'Snapshot of OMS oms_orders.total_cents at sync time (amount actually paid by customer). Integer cents; no floats. Populated by wmsSyncService (Group B). Never NULL.';

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS tax_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.orders.tax_cents IS
  'Snapshot of OMS oms_orders.tax_cents at sync time. Integer cents.';

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS shipping_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.orders.shipping_cents IS
  'Snapshot of OMS oms_orders.shipping_cents at sync time. Integer cents.';

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS discount_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.orders.discount_cents IS
  'Snapshot of OMS oms_orders.discount_cents at sync time. Integer cents.';

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS total_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN wms.orders.total_cents IS
  'Snapshot of OMS oms_orders.total_cents at sync time. Conceptually duplicates amount_paid_cents so future partial-refund-aware code can evolve without schema change (plan §4.1).';

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

COMMENT ON COLUMN wms.orders.currency IS
  'ISO 4217 currency code snapshot from OMS. Defaults to USD for back-compat.';

-- ---------------------------------------------------------------------
-- Index on oms_fulfillment_order_id (plan §4.9 — verify/create)
-- ---------------------------------------------------------------------
--
-- Used by ship-notify lookup + backfill joins. The column has existed
-- for a while without an explicit index; adding it here is harmless if
-- one already exists (CREATE INDEX IF NOT EXISTS is idempotent).

CREATE INDEX IF NOT EXISTS idx_wms_orders_oms_fulfillment_order_id
  ON wms.orders (oms_fulfillment_order_id)
  WHERE oms_fulfillment_order_id IS NOT NULL;
