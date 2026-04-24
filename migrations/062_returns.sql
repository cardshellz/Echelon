-- Migration: 062_returns
-- Creates a new table wms.returns to record return events against
-- shipments (primarily triggered by Shopify refunds/create webhooks).
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.5, §6 Group A
-- Commit 6, §7 (migration table).
--
-- Purpose:
--   Minimal record-keeping for returns so Group D can log an event row
--   whenever Shopify fires refunds/create (with or without restock).
--   This is explicitly a stub: the full RMA workflow (exchange, re-ship,
--   warehouse bin allocation, customer-facing portal) is a later
--   project and a non-goal of the ShipStation-flow refactor
--   (plan §1.3 non-goal). Hook points for the later RMA work are noted
--   in Group F commits.
--
-- Safety notes:
--   - NEW table only. No existing table is altered.
--   - No backfill: zero historical rows are inserted; the table is
--     empty at release.
--   - No reader and no writer yet: Group D will add the writer (from
--     oms-webhooks refunds/create). Until that lands this table is
--     completely inert.
--   - Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
--     EXISTS so re-running is a no-op.
--   - Data risk: zero (new table, no reader, no writer at this commit).
--
-- Reverse migration: migrations/reverse/062_returns.sql
--   Drops the table (and therefore its indexes) with CASCADE. Safe to
--   run now; dangerous once Group D / Group F start writing.

CREATE TABLE IF NOT EXISTS wms.returns (
  id                    bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id           integer      NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE CASCADE,
  order_id              integer      NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  source                varchar(30)  NOT NULL DEFAULT 'shopify_webhook',
  reason                varchar(200),
  refund_external_id    varchar(100),
  restocked             boolean      NOT NULL DEFAULT false,
  received_at           timestamp,
  refunded_at           timestamp,
  notes                 text,
  created_at            timestamp    NOT NULL DEFAULT now(),
  updated_at            timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_returns_shipment_id
  ON wms.returns(shipment_id);

CREATE INDEX IF NOT EXISTS idx_returns_order_id
  ON wms.returns(order_id);

CREATE INDEX IF NOT EXISTS idx_returns_refund_external_id
  ON wms.returns(refund_external_id)
  WHERE refund_external_id IS NOT NULL;
