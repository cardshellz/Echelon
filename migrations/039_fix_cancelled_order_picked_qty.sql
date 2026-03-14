-- Migration 039: Fix stranded pickedQty from cancelled orders
-- One-time cleanup: find all cancelled orders that have order_items with
-- picked_quantity > 0, and reconcile the corresponding inventory_levels.
--
-- This migration reverses the pickedQty leak: for each stranded item, it
-- moves units from pickedQty back to variantQty in inventory_levels, and
-- resets the order_item's picked_quantity to 0.
--
-- Safety: only touches cancelled orders. Uses LEAST() to avoid negative values.
-- Idempotent: running twice won't cause issues (second run finds nothing).

-- Step 1: Identify stranded items and fix inventory_levels
-- For each cancelled order item with picked_quantity > 0, find the pick
-- location from inventory_transactions and restore pickedQty → variantQty.
DO $$
DECLARE
  rec RECORD;
  pick_location_id INTEGER;
  level_id INTEGER;
  level_picked INTEGER;
  qty_to_release INTEGER;
  total_fixed INTEGER := 0;
BEGIN
  FOR rec IN
    SELECT
      oi.id AS order_item_id,
      oi.order_id,
      oi.sku,
      oi.picked_quantity,
      pv.id AS variant_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN product_variants pv ON UPPER(pv.sku) = UPPER(oi.sku)
    WHERE o.cancelled_at IS NOT NULL
      AND oi.picked_quantity > 0
  LOOP
    -- Find the pick location from transaction history
    SELECT it.from_location_id INTO pick_location_id
    FROM inventory_transactions it
    WHERE it.order_id = rec.order_id
      AND it.product_variant_id = rec.variant_id
      AND it.transaction_type = 'pick'
      AND it.from_location_id IS NOT NULL
    ORDER BY it.created_at DESC
    LIMIT 1;

    IF pick_location_id IS NOT NULL THEN
      -- Find the inventory level at that location
      SELECT il.id, il.picked_qty
      INTO level_id, level_picked
      FROM inventory_levels il
      WHERE il.product_variant_id = rec.variant_id
        AND il.warehouse_location_id = pick_location_id;

      IF level_id IS NOT NULL AND level_picked > 0 THEN
        qty_to_release := LEAST(rec.picked_quantity, level_picked);

        IF qty_to_release > 0 THEN
          -- Atomically move pickedQty back to variantQty
          UPDATE inventory_levels
          SET picked_qty = picked_qty - qty_to_release,
              variant_qty = variant_qty + qty_to_release,
              updated_at = NOW()
          WHERE id = level_id;

          -- Log the correction as an inventory transaction
          INSERT INTO inventory_transactions (
            product_variant_id, from_location_id, to_location_id,
            transaction_type, variant_qty_delta,
            source_state, target_state,
            order_id, order_item_id,
            reference_type, reference_id,
            notes, user_id
          ) VALUES (
            rec.variant_id, pick_location_id, pick_location_id,
            'unreserve', qty_to_release,
            'picked', 'on_hand',
            rec.order_id, rec.order_item_id,
            'migration', '039_fix_cancelled_order_picked_qty',
            'Migration cleanup: stranded pickedQty from cancelled order released back to on-hand',
            'system'
          );

          total_fixed := total_fixed + 1;
        END IF;
      END IF;
    END IF;

    -- Reset the order item's picked_quantity regardless
    UPDATE order_items
    SET picked_quantity = 0, status = 'cancelled'
    WHERE id = rec.order_item_id;
  END LOOP;

  RAISE NOTICE 'Migration 039: Fixed % stranded pickedQty items from cancelled orders', total_fixed;
END $$;

-- ROLLBACK:
-- This migration is corrective. To reverse it, you would need to re-read
-- the inventory_transactions with reference_id = '039_fix_cancelled_order_picked_qty'
-- and apply the inverse adjustments. Not recommended — the fix is the correct state.
