-- Migration: 103_line_fulfillments_ledger
-- Phase 0 of the fulfillment-state redesign (FULFILLMENT_STATE_DESIGN.md §2.1, §7).
--
-- Adds the append-only, channel/engine-NEUTRAL per-line shipment ledger that
-- becomes the single source of truth for net_shipped_qty per order line, plus
-- the per-line hold columns (§2.3). Everything (line -> shipment -> WMS order ->
-- OMS order status) will derive from this ledger once cutover lands.
--
-- INERT at this phase: no reader, no writer in application code yet. Backfill is
-- Phase 1 (scripts/backfill-line-fulfillments.ts); dual-write is Phase 2.
--
-- Safety notes:
--   - NEW table + ADDITIVE columns only; no existing table data is altered.
--   - Idempotent: CREATE TABLE / INDEX / ADD COLUMN all use IF NOT EXISTS,
--     so re-running (and the server/db.ts startup-fallback mirror) is a no-op.
--   - Data risk: zero (new table, no reader/writer; additive nullable/defaulted
--     columns on wms.order_items).
--   - Reverse migration: migrations/reverse/103_line_fulfillments_ledger.sql.
--
-- Column types: order_item_id / shipment_id are INTEGER because wms.order_items.id
-- and wms.outbound_shipments.id are integer identity columns (orders.schema.ts).

CREATE TABLE IF NOT EXISTS wms.line_fulfillments (
  id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id     integer      NOT NULL REFERENCES wms.order_items(id),
  shipment_id       integer      NOT NULL REFERENCES wms.outbound_shipments(id),
  qty               integer      NOT NULL,
  kind              varchar(20)  NOT NULL,
  source            varchar(30)  NOT NULL,
  external_event_id varchar(200),
  occurred_at       timestamptz  NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT line_fulfillments_qty_nonzero_chk CHECK (qty <> 0),
  CONSTRAINT line_fulfillments_kind_chk
    CHECK (kind IN ('shipped', 'void_reversal', 'return', 'manual_correction')),
  CONSTRAINT line_fulfillments_source_chk
    CHECK (source IN ('warehouse', 'reconcile', 'operator'))
);

-- Idempotency / replay-safety (§2.1). NOTE: Postgres treats NULLs as DISTINCT in
-- a UNIQUE index, so this guarantee only holds when external_event_id is non-null.
-- Every writer (the Phase-1 backfill and the Phase-3 recordFulfillmentEvent seam)
-- MUST always set external_event_id (e.g. 'backfill:'||shipment_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_line_fulfillments_idempotency
  ON wms.line_fulfillments (order_item_id, shipment_id, kind, external_event_id);

-- net_shipped_qty(line) is a SUM over this column per recompute.
CREATE INDEX IF NOT EXISTS idx_line_fulfillments_order_item
  ON wms.line_fulfillments (order_item_id);

-- Helps void/return reversal lookups by shipment.
CREATE INDEX IF NOT EXISTS idx_line_fulfillments_shipment
  ON wms.line_fulfillments (shipment_id);

-- Per-line hold overlay (§2.3). Boolean per the design; the order-level
-- wms.orders.on_hold flag stays integer 1/0 (derivation coerces both — D1).
ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS hold_reason varchar(200);
