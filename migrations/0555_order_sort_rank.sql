-- 0555_order_sort_rank.sql
-- Flatten the 5-dimensional pick queue sort order into a single
-- lexicographically-sortable string. Pushed to ShipStation as
-- customField1 so packer grid sorts identical to picker queue.
--
-- Format: H-B-PPPP-SSSSSS-AAAAAAAAAA  (22 chars)
--   H  = 1 if NOT on hold, 0 if held
--   B  = 1 if bumped (priority>=9999), 0 otherwise
--   PPPP = priority, zero-padded to 4 digits
--   SSSSSS = SLA urgency (higher = closer to breach), 6 digits
--   AAAAAAAAAA = 9999999999 minus unix_timestamp(placed_at), 10 digits
--
-- Sort DESCENDING = Echelon pick queue order.
--
-- Idempotent.

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS sort_rank VARCHAR(24);

CREATE INDEX IF NOT EXISTS idx_wms_orders_sort_rank
  ON wms.orders(sort_rank DESC);
