-- 0561_unit_cost_mills.sql
-- 4-decimal per-unit cost precision ("mills" = 1/10000 of a dollar).
--
-- Per Overlord 2026-04-22 spec: per-unit cost gets 4-decimal precision;
-- everything else (line totals, PO totals, invoices, payments, COGS, margin)
-- stays in cents. We add NULLABLE BIGINT `unit_cost_mills` columns alongside
-- the existing `unit_cost_cents` columns so:
--
--   * Mills is authoritative for per-unit cost going forward.
--   * `unit_cost_cents` stays populated (rounded from mills) for back-compat
--     with every consumer that hasn't migrated yet.
--   * No existing data migration needed — columns start NULL and are filled
--     by the new code paths.
--
-- Safe to re-run: every column uses IF NOT EXISTS.
--
-- Conversions (integer-only, half-up at the .5 boundary):
--   cents_from_mills = round_half_up(mills / 100)
--   line_total_cents = round_half_up(unit_cost_mills * order_qty / 100)

-- ---------------------------------------------------------------------
-- (a) procurement.vendor_products — negotiated per-unit cost
-- ---------------------------------------------------------------------

ALTER TABLE procurement.vendor_products
  ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT;

COMMENT ON COLUMN procurement.vendor_products.unit_cost_mills IS
  'Negotiated per-unit cost in mills (1/10000 of a dollar). Authoritative source for unit cost; unit_cost_cents is kept in sync (rounded) for back-compat.';

-- ---------------------------------------------------------------------
-- (b) procurement.purchase_order_lines — per-line ordered cost
-- ---------------------------------------------------------------------

ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT;

COMMENT ON COLUMN procurement.purchase_order_lines.unit_cost_mills IS
  'Per-unit cost in mills. When present, authoritative; line_total_cents is derived from mills × order_qty (half-up).';

-- ---------------------------------------------------------------------
-- (c) procurement.vendor_invoice_lines — invoiced per-unit cost
-- ---------------------------------------------------------------------

ALTER TABLE procurement.vendor_invoice_lines
  ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT;

COMMENT ON COLUMN procurement.vendor_invoice_lines.unit_cost_mills IS
  'Per-unit invoiced cost in mills. unit_cost_cents kept in sync (rounded) for back-compat.';

-- ---------------------------------------------------------------------
-- (d) procurement.po_receipts — PO and actual receipt unit cost
-- ---------------------------------------------------------------------

ALTER TABLE procurement.po_receipts
  ADD COLUMN IF NOT EXISTS po_unit_cost_mills     BIGINT,
  ADD COLUMN IF NOT EXISTS actual_unit_cost_mills BIGINT;

COMMENT ON COLUMN procurement.po_receipts.po_unit_cost_mills IS
  'PO line unit cost snapshot at receive time, in mills. Mirror of po_unit_cost_cents but at 4-decimal precision.';
COMMENT ON COLUMN procurement.po_receipts.actual_unit_cost_mills IS
  'Actual receipt unit cost (e.g. landed cost), in mills. Mirror of actual_unit_cost_cents at 4-decimal precision.';

-- NOTE: procurement.receiving_lines carries per-unit cost under the `unit_cost`
-- column (plain cents), not `unit_cost_cents`. Per spec scope ("if table has
-- unit_cost_cents") we do NOT add a mills column to receiving_lines in this
-- migration. Receive-time precision is preserved by pulling unit_cost_mills
-- from the linked purchase_order_lines row and rounding to cents on write.
