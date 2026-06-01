-- Phase 1: Inventory ledger immutability + forward-only on-hand guard.
--
-- Scope is deliberately conservative — it adds protection WITHOUT mutating any
-- existing financial data:
--   1. voided_at on inventory_transactions  → soft-delete replaces hard DELETE (C5)
--   2. CHECK (variant_qty >= 0) NOT VALID    → blocks NEW negative writes (C2),
--      but leaves existing negative drift in place for the Phase 0 reconciler to
--      surface and correct via ledgered adjustments (CLAUDE.md: flag, don't force).
--
-- C1 (unique on variant,location) is already enforced by the existing
-- idx_inventory_levels_variant_location unique index (server/db.ts), so it is NOT
-- re-declared here.

-- C5: ledger rows become immutable — void instead of delete.
ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz DEFAULT NULL;

-- C2: forbid NEW negative on-hand. NOT VALID so existing rows are not rejected;
-- every INSERT/UPDATE from now on is checked. Existing negatives remain visible
-- to the reconciler and get corrected through the guarded adjustment path.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_variant_qty_non_negative'
  ) THEN
    ALTER TABLE inventory.inventory_levels
      ADD CONSTRAINT chk_variant_qty_non_negative CHECK (variant_qty >= 0) NOT VALID;
  END IF;
END $$;
