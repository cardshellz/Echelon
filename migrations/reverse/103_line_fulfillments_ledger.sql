-- Reverse migration: 103_line_fulfillments_ledger
-- Reverses migrations/103_line_fulfillments_ledger.sql.
--
-- !!! DATA-LOSS WARNING !!!
--   Dropping wms.line_fulfillments destroys the per-line shipment ledger.
--
--   - SAFE to run at Phase 0/1: the ledger is either empty (Phase 0) or holds
--     only reconstructable backfill rows (Phase 1, rebuildable from
--     wms.outbound_shipment_items via scripts/backfill-line-fulfillments.ts).
--   - DANGEROUS once cutover lands (Phase 3): the ledger becomes the single
--     source of truth for net_shipped_qty. Dropping it then loses live
--     fulfillment facts (incl. void/return reversals) that drive every order's
--     status. Re-derive from channel/shipment truth before relying on this.
--
-- Idempotent: DROP TABLE IF EXISTS ... CASCADE removes the table + its indexes.
-- The additive on_hold/hold_reason columns on wms.order_items are dropped too;
-- both are nullable/defaulted, so dropping them loses only per-line hold state.

DROP TABLE IF EXISTS wms.line_fulfillments CASCADE;

ALTER TABLE wms.order_items DROP COLUMN IF EXISTS on_hold;
ALTER TABLE wms.order_items DROP COLUMN IF EXISTS hold_reason;
