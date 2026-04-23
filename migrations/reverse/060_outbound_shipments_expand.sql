-- Reverse migration: 060_outbound_shipments_expand
-- Reverses migrations/060_outbound_shipments_expand.sql.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.3, §6 Group A
-- Commit 4, §7 (migration table).
--
-- !!! DATA-LOSS WARNING !!!
--   - All 12 lifecycle / linkage columns added by the forward migration
--     are DROPPED. Any values written into them between the forward and
--     reverse runs are LOST. Columns affected:
--       shipstation_order_id, shipstation_order_key, shopify_fulfillment_id,
--       requires_review, review_reason, address_changed_after_label,
--       voided_at, voided_reason, on_hold_reason,
--       cancelled_at, returned_at, last_reconciled_at
--     Running this reverse AFTER Groups B–F have landed will destroy
--     live shipment linkage state; do NOT execute in production once
--     those groups are writing to these columns without a recovery plan.
--   - The `status` column is converted back from the wms.shipment_status
--     enum to varchar(20), BUT the remapped values remain:
--         pending   stays 'planned'
--         packed    stays 'queued'
--         delivered stays 'shipped'
--     The original pre-remap values are NOT restored. This is a plan
--     decision (§6 Commit 4): the remap is forward-only. Any caller that
--     depends on the pre-remap vocabulary ('pending' / 'packed' /
--     'delivered') must be fixed elsewhere or restore from backup.
--   - The enum type wms.shipment_status is dropped.
--
-- Safety:
--   - Every DROP uses IF EXISTS.
--   - The default on `status` is reset to 'pending' to match the
--     pre-migration schema (shared/schema/orders.schema.ts default
--     before this commit).

-- ─────────────────────────────────────────────────────────────────────────
-- Drop Phase 2d indexes.
-- ─────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS wms.idx_outbound_shipments_status;
DROP INDEX IF EXISTS wms.idx_outbound_shipments_requires_review;
DROP INDEX IF EXISTS wms.idx_outbound_shipments_shipstation_order_id;

-- ─────────────────────────────────────────────────────────────────────────
-- Drop Phase 2c lifecycle / linkage columns.
-- ─────────────────────────────────────────────────────────────────────────

-- ShipStation ↔ Shopify linkage.
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS shipstation_order_id;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS shipstation_order_key;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS shopify_fulfillment_id;

-- Ops review flags.
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS requires_review;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS review_reason;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS address_changed_after_label;

-- Lifecycle timestamps.
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS voided_at;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS voided_reason;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS on_hold_reason;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS cancelled_at;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS returned_at;
ALTER TABLE wms.outbound_shipments DROP COLUMN IF EXISTS last_reconciled_at;

-- ─────────────────────────────────────────────────────────────────────────
-- Reverse Phase 2b: convert status back to varchar(20), reset default.
-- The remapped values (planned / queued / shipped from delivered) are
-- preserved as-is — see data-loss warning above.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status TYPE varchar(20)
  USING status::text;

ALTER TABLE wms.outbound_shipments
  ALTER COLUMN status SET DEFAULT 'pending';

-- ─────────────────────────────────────────────────────────────────────────
-- Reverse Phase 2a: drop the enum type. Must come AFTER the column type
-- conversion above; Postgres will refuse to drop a type still in use.
-- ─────────────────────────────────────────────────────────────────────────
DROP TYPE IF EXISTS wms.shipment_status;
