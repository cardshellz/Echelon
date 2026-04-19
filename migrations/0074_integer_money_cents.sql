-- Migration: Convert IEEE-754 double precision monetary columns to integer cents
-- Note: the schema definitions were changed in shared/schema/*.schema.ts
-- Drizzle interactive generation stalled on the existing ~auth_permissions table bug,
-- so this manual execution applies exactly what the Drizzle typescript types define.

ALTER TABLE "catalog"."product_variants" ALTER COLUMN "standard_cost_cents" TYPE integer USING round("standard_cost_cents"::numeric);
ALTER TABLE "catalog"."product_variants" ALTER COLUMN "last_cost_cents" TYPE integer USING round("last_cost_cents"::numeric);
ALTER TABLE "catalog"."product_variants" ALTER COLUMN "avg_cost_cents" TYPE integer USING round("avg_cost_cents"::numeric);

ALTER TABLE "inventory"."inventory_transactions" ALTER COLUMN "unit_cost_cents" TYPE integer USING round("unit_cost_cents"::numeric);
ALTER TABLE "inventory"."inventory_lots" ALTER COLUMN "unit_cost_cents" TYPE integer USING round("unit_cost_cents"::numeric);

ALTER TABLE "procurement"."vendor_products" ALTER COLUMN "unit_cost_cents" TYPE integer USING round("unit_cost_cents"::numeric);
ALTER TABLE "procurement"."vendor_products" ALTER COLUMN "last_cost_cents" TYPE integer USING round("last_cost_cents"::numeric);

ALTER TABLE "procurement"."receiving_lines" ALTER COLUMN "unit_cost" TYPE integer USING round("unit_cost"::numeric);

ALTER TABLE "procurement"."purchase_order_lines" ALTER COLUMN "unit_cost_cents" TYPE integer USING round("unit_cost_cents"::numeric);
ALTER TABLE "procurement"."purchase_order_lines" ALTER COLUMN "discount_cents" TYPE integer USING round("discount_cents"::numeric);
ALTER TABLE "procurement"."purchase_order_lines" ALTER COLUMN "tax_cents" TYPE integer USING round("tax_cents"::numeric);
ALTER TABLE "procurement"."purchase_order_lines" ALTER COLUMN "line_total_cents" TYPE integer USING round("line_total_cents"::numeric);

ALTER TABLE "procurement"."po_receipts" ALTER COLUMN "po_unit_cost_cents" TYPE integer USING round("po_unit_cost_cents"::numeric);
ALTER TABLE "procurement"."po_receipts" ALTER COLUMN "actual_unit_cost_cents" TYPE integer USING round("actual_unit_cost_cents"::numeric);
ALTER TABLE "procurement"."po_receipts" ALTER COLUMN "variance_cents" TYPE integer USING round("variance_cents"::numeric);

ALTER TABLE "procurement"."inbound_shipment_lines" ALTER COLUMN "landed_unit_cost_cents" TYPE integer USING round("landed_unit_cost_cents"::numeric);

ALTER TABLE "procurement"."landed_cost_snapshots" ALTER COLUMN "po_unit_cost_cents" TYPE integer USING round("po_unit_cost_cents"::numeric);
ALTER TABLE "procurement"."landed_cost_snapshots" ALTER COLUMN "landed_unit_cost_cents" TYPE integer USING round("landed_unit_cost_cents"::numeric);

ALTER TABLE "procurement"."vendor_invoice_lines" ALTER COLUMN "unit_cost_cents" TYPE integer USING round("unit_cost_cents"::numeric);
ALTER TABLE "procurement"."vendor_invoice_lines" ALTER COLUMN "line_total_cents" TYPE integer USING round("line_total_cents"::numeric);
