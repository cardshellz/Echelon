ALTER TABLE inventory.replen_tasks
  ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES wms.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS order_item_id INTEGER REFERENCES wms.order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS blocks_shipment BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_replen_tasks_order_id
  ON inventory.replen_tasks(order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_replen_tasks_order_item_id
  ON inventory.replen_tasks(order_item_id)
  WHERE order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_replen_tasks_order_shipment_blockers
  ON inventory.replen_tasks(order_id, status)
  WHERE order_id IS NOT NULL
    AND blocks_shipment = TRUE
    AND status NOT IN ('completed', 'cancelled');
