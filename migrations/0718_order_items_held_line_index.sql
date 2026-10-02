-- 0718: Index held lines for the Orders page "On Hold" bucket.
--
-- The order list (server/modules/orders/order-list.repository.ts) files an open order under
-- "On Hold" when any of its lines is held (wms.order_items.on_hold = true), so that probe runs
-- for every open order on every Orders page load. Held lines are rare: a partial index keeps the
-- probe to a lookup in a near-empty index instead of reading every line of the order. The probe
-- must say `on_hold = true` (not COALESCE(on_hold, false)) for the planner to match this index.
--
-- Non-concurrent CREATE: the release-phase runner wraps each migration in a transaction, so
-- CREATE INDEX CONCURRENTLY is not usable here (same as 123). Writes to wms.order_items wait
-- for the brief build; only held lines are written into the index.

CREATE INDEX IF NOT EXISTS idx_order_items_held_order_id
  ON wms.order_items (order_id)
  WHERE on_hold = true;
