-- 116: Reservation quantities become ledger-recorded (P0.1b).
--
-- Problem: reserve/unreserve rows in inventory.inventory_transactions carried
-- no quantity (variant_qty_delta is 0 by convention for reservation state
-- changes), so the open reservation held by a given order could not be
-- reconstructed from the ledger. Releases therefore released the ORDER'S
-- quantity from ANY level of the variant — non-idempotent and able to drain
-- other orders' reservations (oversell), and leaked reservations could not be
-- attributed.
--
-- reserved_qty_delta semantics (variant units):
--   reserve   rows: +qty actually reserved
--   unreserve rows: -qty actually released
--   pick      rows: -(reservation consumed by the pick, capped at the level's
--                     reserved_qty at pick time)
-- NULL means "written before this migration" — consumers must treat NULL-era
-- reservations via the documented conservative fallback.

ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS reserved_qty_delta integer;

COMMENT ON COLUMN inventory.inventory_transactions.reserved_qty_delta IS
  'Reservation counter delta in variant units. reserve:+qty, unreserve:-qty, pick:-(consumed). NULL = pre-116 row.';

-- Order-scoped release and the ready-but-unreserved detector query the ledger
-- by (order_id, order_item_id) filtered to reservation-affecting rows.
CREATE INDEX IF NOT EXISTS idx_invtx_reservation_by_order_item
  ON inventory.inventory_transactions (order_id, order_item_id)
  WHERE transaction_type IN ('reserve', 'unreserve', 'pick') AND voided_at IS NULL;
