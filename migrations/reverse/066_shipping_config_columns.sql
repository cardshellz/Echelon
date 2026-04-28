-- migrations/reverse/066_shipping_config_columns.sql

ALTER TABLE channels.channels
  DROP COLUMN IF EXISTS shipping_config;

ALTER TABLE warehouse.warehouses
  DROP COLUMN IF EXISTS shipping_config;
