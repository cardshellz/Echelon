-- Migration: Add engine-agnostic columns to oms.oms_orders
-- Mirrors the pattern already established on wms.outbound_shipments (migration 0573).
-- Allows OMS layer to reference any shipping engine, not just ShipStation.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS shipping_engine varchar(30),
  ADD COLUMN IF NOT EXISTS engine_order_ref varchar(200);

-- Backfill existing ShipStation rows
UPDATE oms.oms_orders
SET shipping_engine = 'shipstation',
    engine_order_ref = shipstation_order_id::text
WHERE shipstation_order_id IS NOT NULL
  AND shipping_engine IS NULL;

-- Index for engine-scoped lookups
CREATE INDEX IF NOT EXISTS idx_oms_orders_engine_ref
  ON oms.oms_orders (engine_order_ref)
  WHERE engine_order_ref IS NOT NULL;
