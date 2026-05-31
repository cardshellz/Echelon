-- D-QGUARD: Prevent duplicate shipment inventory transactions per item.
-- Application-level SELECT dedup in recordShipment can race under concurrent
-- callers. This partial unique index enforces at the DB layer that only one
-- 'ship' transaction can exist per (reference_id, order_item_id) pair.
-- The application-level check remains as a fast-path optimization.

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_ship_dedup
  ON inventory.inventory_transactions (reference_id, order_item_id)
  WHERE transaction_type = 'ship'
    AND reference_id IS NOT NULL
    AND order_item_id IS NOT NULL;
