-- Recipe-managed order lines can be supplied by existing finished inventory
-- plus a build promise for the remaining quantity. Preserve retry safety per
-- supply segment instead of prohibiting every second reserve row on the item.

DROP INDEX IF EXISTS inventory.uq_inventory_transactions_reserve_dedup;

CREATE UNIQUE INDEX uq_inventory_transactions_reserve_dedup
  ON inventory.inventory_transactions (
    order_id,
    order_item_id,
    (COALESCE(reference_type, 'order')),
    (COALESCE(reference_id, order_id::text))
  )
  WHERE transaction_type = 'reserve'
    AND order_id IS NOT NULL
    AND order_item_id IS NOT NULL
    AND voided_at IS NULL;

COMMENT ON INDEX inventory.uq_inventory_transactions_reserve_dedup IS
  'Prevents duplicate active reserve commands per order item and supply segment; '
  'allows finished-stock and recipe-build reservations to coexist.';
