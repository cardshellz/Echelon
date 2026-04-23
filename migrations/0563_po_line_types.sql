-- 0563_po_line_types.sql
-- Future-proof PO lines by introducing a line_type enum (product by default,
-- plus discount / fee / tax / rebate / adjustment) and an optional
-- parent_line_id for line-level modifiers that target a specific product line.
--
-- Non-breaking:
--   - existing rows implicitly become line_type='product' via column default
--   - parent_line_id is nullable; no backfill required
--   - all math is sign-aware at the application layer, so signed line totals
--     (negative for discounts / rebates / some adjustments) sum correctly
--     without schema changes to totals columns
--
-- Safe to re-run: IF NOT EXISTS + DO $$ constraint guards.

-- ---------------------------------------------------------------------------
-- (a) columns
-- ---------------------------------------------------------------------------

ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS line_type VARCHAR(20) NOT NULL DEFAULT 'product',
  ADD COLUMN IF NOT EXISTS parent_line_id INTEGER;

-- ---------------------------------------------------------------------------
-- (b) check constraint: line_type whitelist
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'po_lines_line_type_chk'
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_line_type_chk
      CHECK (line_type IN ('product', 'discount', 'fee', 'tax', 'rebate', 'adjustment'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (c) self-referential FK for parent_line_id
--     ON DELETE SET NULL so removing a parent doesn't cascade-destroy the
--     child adjustment; it remains orphaned in audit.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'po_lines_parent_line_id_fk'
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_parent_line_id_fk
      FOREIGN KEY (parent_line_id)
      REFERENCES procurement.purchase_order_lines(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (d) helpful index for queries that filter on line_type
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_po_lines_type_po
  ON procurement.purchase_order_lines (purchase_order_id, line_type);
