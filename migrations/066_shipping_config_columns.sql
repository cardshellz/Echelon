-- migrations/066_shipping_config_columns.sql
--
-- Add a jsonb shipping_config column to both channels.channels and
-- warehouse.warehouses. The column carries engine-specific routing data,
-- e.g. for ShipStation: {"shipstation": {"storeId": 319989, "warehouseId": 996884}}.
-- Future engines (easypost, shippo, etc.) layer in alongside without a re-migration.
--
-- Both nullable for safe rollout; the resolveShipStationIds helper falls
-- back to env vars when the column is NULL.

ALTER TABLE channels.channels
  ADD COLUMN IF NOT EXISTS shipping_config jsonb;

ALTER TABLE warehouse.warehouses
  ADD COLUMN IF NOT EXISTS shipping_config jsonb;
