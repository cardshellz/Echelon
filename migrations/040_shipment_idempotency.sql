-- Migration 040: Shipment idempotency — code-only fix
--
-- This migration adds an index to speed up the idempotency checks
-- added in Fix 2 (double inventory deduction on shipment).
--
-- The code changes are in:
--   - server/modules/orders/order-sync-listener.ts (Prongs A and C)
--   - server/modules/orders/fulfillment.service.ts (Prong B)
--
-- Prong A: syncOrderUpdate checks for existing shipments before deducting
-- Prong B: Webhook path now updates order_items.picked_quantity
-- Prong C: deductInventoryForExternalShipment checks for existing 'ship'
--          transactions before deducting

-- Index to speed up "SELECT id FROM shipments WHERE order_id = ? AND status IN (...)"
-- Used by the idempotency check in syncOrderUpdate
CREATE INDEX IF NOT EXISTS idx_shipments_order_status
  ON shipments (order_id, status);

-- Index to speed up "SELECT id FROM inventory_transactions WHERE order_id = ? AND transaction_type = 'ship'"
-- Used by the idempotency check in deductInventoryForExternalShipment
CREATE INDEX IF NOT EXISTS idx_inv_txn_order_type
  ON inventory_transactions (order_id, transaction_type);

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_shipments_order_status;
-- DROP INDEX IF EXISTS idx_inv_txn_order_type;
