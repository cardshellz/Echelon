-- Reverse migration: 110_oms_provider_fulfillment_references
-- Reverses migrations/110_oms_provider_fulfillment_references.sql.
--
-- DATA-LOSS WARNING:
--   Dropping these columns destroys provider-neutral fulfillment references on
--   OMS order lines. Shopify compatibility columns remain, but non-Shopify
--   provider references stored only in the neutral columns will be lost.
--
-- Safe only before application callers start writing provider-neutral values
-- for eBay, dropship, or other fulfillment providers.

DROP INDEX IF EXISTS oms.idx_oms_lines_provider_fulfillment_line;
DROP INDEX IF EXISTS oms.idx_oms_lines_provider_fulfillment_order;

ALTER TABLE oms.oms_order_lines
  DROP COLUMN IF EXISTS provider_fulfillment_order_line_item_id,
  DROP COLUMN IF EXISTS provider_fulfillment_order_id,
  DROP COLUMN IF EXISTS fulfillment_provider;
