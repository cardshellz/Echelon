-- Phase 2: Align DB column types with Drizzle schema.
--
-- Migration 0074 converted cost columns from double precision to integer.
-- The Drizzle schema later declared them as bigint. The mismatch is safe
-- (integer → bigint is a widening cast, reads work fine), but a type audit
-- should leave no drift between schema and DB. Upgrade all money columns
-- to bigint to match the schema declarations.
--
-- This is a safe, metadata-only operation on Postgres — integer → bigint
-- does not rewrite the table.

ALTER TABLE catalog.product_variants
  ALTER COLUMN standard_cost_cents TYPE bigint,
  ALTER COLUMN last_cost_cents TYPE bigint,
  ALTER COLUMN avg_cost_cents TYPE bigint,
  ALTER COLUMN price_cents TYPE bigint,
  ALTER COLUMN compare_at_price_cents TYPE bigint;

ALTER TABLE inventory.inventory_transactions
  ALTER COLUMN unit_cost_cents TYPE bigint;

ALTER TABLE inventory.inventory_lots
  ALTER COLUMN unit_cost_cents TYPE bigint;

ALTER TABLE procurement.vendor_products
  ALTER COLUMN unit_cost_cents TYPE bigint,
  ALTER COLUMN last_cost_cents TYPE bigint;

ALTER TABLE procurement.receiving_lines
  ALTER COLUMN unit_cost TYPE bigint;

ALTER TABLE procurement.purchase_order_lines
  ALTER COLUMN unit_cost_cents TYPE bigint,
  ALTER COLUMN discount_cents TYPE bigint,
  ALTER COLUMN tax_cents TYPE bigint,
  ALTER COLUMN line_total_cents TYPE bigint;

ALTER TABLE procurement.po_receipts
  ALTER COLUMN po_unit_cost_cents TYPE bigint,
  ALTER COLUMN actual_unit_cost_cents TYPE bigint,
  ALTER COLUMN variance_cents TYPE bigint;

ALTER TABLE procurement.inbound_shipment_lines
  ALTER COLUMN landed_unit_cost_cents TYPE bigint;

ALTER TABLE procurement.landed_cost_snapshots
  ALTER COLUMN po_unit_cost_cents TYPE bigint,
  ALTER COLUMN landed_unit_cost_cents TYPE bigint;

ALTER TABLE procurement.vendor_invoice_lines
  ALTER COLUMN unit_cost_cents TYPE bigint,
  ALTER COLUMN line_total_cents TYPE bigint;
