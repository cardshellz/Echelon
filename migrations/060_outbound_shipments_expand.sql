-- Migration: 060_outbound_shipments_expand
-- Expands wms.outbound_shipments from a simple audit sink into a
-- first-class shipment entity with its own lifecycle enum and lifecycle
-- columns.
--
-- Plan reference: shipstation-flow-refactor-plan.md §2 (invariants #3 and
-- #4), §4.3, §6 Group A Commit 4, §7 (migration table).
--
-- Architecture context:
--   - Invariant #3: shipment is a first-class entity. Each shipment owns
--     its own lifecycle (planned -> queued -> labeled -> shipped; terminal
--     branches on_hold, voided, cancelled, returned, lost), its own
--     tracking, its own shipstation_order_id, its own
--     shopify_fulfillment_id.
--   - Invariant #4: wms.orders.warehouse_status is derived as a roll-up
--     from shipments via recomputeOrderStatusFromShipments(wmsOrderId).
--
--   This migration lays the schema foundation; no behaviour changes until
--   later commits (Group B onward) begin writing the new columns. Every
--   new column is nullable or has a safe default so existing INSERTs and
--   UPDATEs continue to work untouched.
--
-- !!! REQUIRED PRE-FLIGHT !!!
--   Before running this migration, run:
--
--     heroku run -a cardshellz-echelon -- \
--       "npx tsx scripts/audit-shipment-status-values.ts"
--
--   and confirm it exits 0 ("CLEAN"). If it exits non-zero the enum cast
--   in Phase 2b will fail and the ALTER TABLE will abort. The audit
--   script is idempotent and read-only; run it as many times as needed.
--
-- Phase overview (single file, single deploy):
--   2a  create the wms.shipment_status enum type (idempotent)
--   2b  remap legacy status values in-place, then convert the column
--       type to the new enum and update the default
--   2c  add 12 new lifecycle + linkage columns
--   2d  add 3 supporting indexes
--
-- Safety:
--   - Every DDL is idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION
--     WHEN duplicate_object` guards, `UPDATE ... WHERE status = 'x'` is
--     a no-op on second run because the value is already normalised).
--   - Zero data risk for the column-add phase (2c): all new columns are
--     nullable or default to `false`.
--   - Medium data risk for the enum-cast phase (2b): a row with an
--     unmapped status would fail the ALTER. The audit script above is the
--     gate that prevents this.
--   - Reverse migration: migrations/reverse/060_outbound_shipments_expand.sql
--     drops the indexes, drops the added columns, converts the status
--     column back to varchar(20), and drops the enum. The reverse DOES
--     NOT un-remap values (planned/queued stay as-is); callers that run
--     the reverse must understand that data nuance.
--   - Designed for Heroku release phase execution.

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2a: create the wms.shipment_status enum type.
-- ─────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wms.shipment_status AS ENUM (
    'planned',
    'queued',
    'labeled',
    'shipped',
    'on_hold',
    'voided',
    'cancelled',
    'returned',
    'lost'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2b: remap legacy status values, then switch the column to the
-- new enum type. Mapping (per plan §6 Commit 4):
--   pending    -> planned
--   packed     -> queued
--   shipped    -> shipped   (unchanged)
--   delivered  -> shipped   (delivered-as-terminal deferred to a later column)
-- ─────────────────────────────────────────────────────────────────────────
UPDATE wms.outbound_shipments SET status = 'planned' WHERE status = 'pending';
UPDATE wms.outbound_shipments SET status = 'queued'  WHERE status = 'packed';
UPDATE wms.outbound_shipments SET status = 'shipped' WHERE status = 'delivered';

ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status TYPE wms.shipment_status
  USING status::wms.shipment_status;

ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status SET DEFAULT 'planned';

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2c: add lifecycle + linkage columns. All ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────

-- ShipStation ↔ Shopify linkage (canonical pointers, per invariant #3).
ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS shipstation_order_id integer;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS shipstation_order_key varchar(100);

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS shopify_fulfillment_id varchar(100);

-- Ops review flags (surfaced in warehouse UI).
ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT false;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS review_reason varchar(100);

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS address_changed_after_label boolean NOT NULL DEFAULT false;

-- Lifecycle timestamps (set on the state-machine transitions in §2.4).
ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS voided_at timestamp;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS voided_reason varchar(200);

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS on_hold_reason varchar(200);

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS cancelled_at timestamp;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS returned_at timestamp;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamp;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2d: supporting indexes.
-- ─────────────────────────────────────────────────────────────────────────

-- Every read that filters by lifecycle state benefits from this.
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_status
  ON wms.outbound_shipments(status);

-- Partial index: only rows flagged for ops review. Cheap because the set
-- is expected to be tiny (review is an exception, not the rule).
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_requires_review
  ON wms.outbound_shipments(requires_review)
  WHERE requires_review = true;

-- Partial index: lookup by SS order id is the canonical SHIP_NOTIFY
-- resolver path in Group D; most legacy rows will be NULL indefinitely.
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_shipstation_order_id
  ON wms.outbound_shipments(shipstation_order_id)
  WHERE shipstation_order_id IS NOT NULL;
