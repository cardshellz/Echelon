-- Migration: Add CHECK constraint to prevent over-reservation
-- reservedQty must never exceed variantQty

ALTER TABLE inventory.inventory_levels
  ADD CONSTRAINT chk_reserved_lte_onhand
  CHECK (reserved_qty <= variant_qty);

-- Backfill: zero out any existing over-reservations
UPDATE inventory.inventory_levels
SET reserved_qty = LEAST(reserved_qty, variant_qty)
WHERE reserved_qty > variant_qty;
