-- 0560_shipstation_reconcile_marker.sql
-- Tracks the last time the OMS<->ShipStation reconcile sweep processed
-- this order, so we don't re-hit already-synced orders every hour.
-- Idempotent.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS shipstation_reconciled_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_oms_orders_ss_reconcile
  ON oms.oms_orders(shipstation_reconciled_at)
  WHERE shipstation_order_id IS NOT NULL;
