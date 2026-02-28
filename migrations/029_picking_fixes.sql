-- Migration 029: Picking system data cleanup
-- Delete product_locations assignments on non-pick locations (G-11, G-12, I-11)
-- Zero out orphaned reserved_qty on non-pick locations (H-12, J-07, etc.)

-- 1. Delete product_locations assignments on non-pick locations
DELETE FROM product_locations pl
USING warehouse_locations wl
WHERE pl.warehouse_location_id = wl.id
  AND wl.is_pickable != 1;

-- 2. Zero out reserved_qty on non-pick locations
UPDATE inventory_levels il
SET reserved_qty = 0
FROM warehouse_locations wl
WHERE il.warehouse_location_id = wl.id
  AND wl.is_pickable != 1
  AND il.reserved_qty != 0;
