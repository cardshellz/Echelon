-- Phase 2: Fix all money column type violations found by querying the live DB.
--
-- Three categories of violations:
--
-- 1. DOUBLE PRECISION (actual floating-point money — DANGEROUS):
--    oms.order_item_costs.{unit_cost_cents, total_cost_cents}
--    oms.order_item_financials.{avg_selling_price_cents, avg_unit_cost_cents}
--    These violate CLAUDE.md §4 ("never floating point for money").
--
-- 2. INTEGER → BIGINT alignment:
--    Migration 0074 converted columns to integer, but the Drizzle schema
--    declares bigint. Safe in practice (widening cast), but should match.
--
-- 3. NUMERIC → BIGINT alignment (inventory_lots cost columns):
--    numeric is exact-decimal (not floating point), so not a correctness
--    issue, but the raw-SQL code treats them as integer cents via Number().
--    Converting to bigint makes them consistent with the rest of the system.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. FIX DOUBLE PRECISION → BIGINT (the real violations)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE oms.order_item_costs
  ALTER COLUMN unit_cost_cents TYPE bigint USING round(unit_cost_cents::numeric),
  ALTER COLUMN total_cost_cents TYPE bigint USING round(total_cost_cents::numeric);

ALTER TABLE oms.order_item_financials
  ALTER COLUMN avg_selling_price_cents TYPE bigint USING round(avg_selling_price_cents::numeric),
  ALTER COLUMN avg_unit_cost_cents TYPE bigint USING round(avg_unit_cost_cents::numeric);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ALIGN INTEGER → BIGINT (to match Drizzle schema declarations)
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ALIGN NUMERIC → BIGINT (inventory_lots landed cost columns)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE inventory.inventory_lots
  ALTER COLUMN po_unit_cost_cents TYPE bigint USING round(po_unit_cost_cents::numeric),
  ALTER COLUMN landed_cost_cents TYPE bigint USING round(landed_cost_cents::numeric),
  ALTER COLUMN total_unit_cost_cents TYPE bigint USING round(total_unit_cost_cents::numeric);

-- inventory.order_line_costs — also numeric in DB, schema says bigint
ALTER TABLE inventory.order_line_costs
  ALTER COLUMN unit_cost_cents TYPE bigint USING round(unit_cost_cents::numeric),
  ALTER COLUMN total_cost_cents TYPE bigint USING round(total_cost_cents::numeric);

-- inventory.cost_adjustment_log — numeric in DB
ALTER TABLE inventory.cost_adjustment_log
  ALTER COLUMN old_cost_cents TYPE bigint USING round(old_cost_cents::numeric),
  ALTER COLUMN new_cost_cents TYPE bigint USING round(new_cost_cents::numeric),
  ALTER COLUMN delta_cents TYPE bigint USING round(delta_cents::numeric);
