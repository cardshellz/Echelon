-- C9: Engine-agnostic shipment references
--
-- Adds generic shipping engine columns to outbound_shipments alongside
-- the existing shipstation_order_id / shipstation_order_key columns.
-- The SS columns remain as back-compat shadow during migration.
--
-- The adapter populates both the new triple AND the shadow columns so
-- existing queries continue to work until callers are migrated.

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS shipping_engine varchar(30),
  ADD COLUMN IF NOT EXISTS engine_order_ref varchar(200),
  ADD COLUMN IF NOT EXISTS engine_shipment_ref varchar(200);

-- Backfill existing ShipStation rows: any shipment with a shipstation_order_id
-- gets the engine triple populated from its existing data.
UPDATE wms.outbound_shipments
SET shipping_engine = 'shipstation',
    engine_order_ref = shipstation_order_id::text,
    engine_shipment_ref = shipstation_order_key
WHERE shipstation_order_id IS NOT NULL
  AND shipping_engine IS NULL;

-- Index for engine-scoped lookups (replaces bare shipstation_order_id scans)
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_engine_ref
  ON wms.outbound_shipments (shipping_engine, engine_order_ref)
  WHERE shipping_engine IS NOT NULL;
