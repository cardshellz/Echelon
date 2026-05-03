-- Migration 067: Replace flat UNIQUE constraints on auto-generated number fields
-- with partial unique indexes that exclude cancelled/voided records.
--
-- Problem: A cancelled shipment "holds hostage" its number forever. Same for
-- cancelled POs, cancelled receipts, and voided payments. Users cannot reuse
-- a number even though the original record is dead.
--
-- Solution: Drop the existing UNIQUE constraints and replace them with
-- partial unique indexes that only enforce uniqueness among active records:
--   - inbound_shipments:  WHERE status <> 'cancelled'
--   - purchase_orders:    WHERE status <> 'cancelled'
--   - receiving_orders:   WHERE status <> 'cancelled'
--   - ap_payments:        WHERE voided_at IS NULL
--
-- Idempotent: all statements use IF EXISTS / IF NOT EXISTS.
--
-- Pre-flight: Verify no active duplicates exist before running.
--   SELECT shipment_number, COUNT(*) FROM procurement.inbound_shipments WHERE status <> 'cancelled' GROUP BY shipment_number HAVING COUNT(*) > 1;
--   SELECT po_number, COUNT(*) FROM procurement.purchase_orders WHERE status <> 'cancelled' GROUP BY po_number HAVING COUNT(*) > 1;
--   SELECT receipt_number, COUNT(*) FROM procurement.receiving_orders WHERE status <> 'cancelled' GROUP BY receipt_number HAVING COUNT(*) > 1;
--   SELECT payment_number, COUNT(*) FROM procurement.ap_payments WHERE voided_at IS NULL GROUP BY payment_number HAVING COUNT(*) > 1;
-- If any return rows, de-duplicate before applying this migration.

BEGIN;

-- 1. inbound_shipments.shipment_number
ALTER TABLE procurement.inbound_shipments
  DROP CONSTRAINT IF EXISTS inbound_shipments_shipment_number_unique;

ALTER TABLE procurement.inbound_shipments
  DROP CONSTRAINT IF EXISTS inbound_shipments_shipment_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS inbound_shipments_shipment_number_active_uidx
  ON procurement.inbound_shipments (shipment_number)
  WHERE status <> 'cancelled';

-- 2. purchase_orders.po_number
ALTER TABLE procurement.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_po_number_unique;

ALTER TABLE procurement.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_po_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_po_number_active_uidx
  ON procurement.purchase_orders (po_number)
  WHERE status <> 'cancelled';

-- 3. receiving_orders.receipt_number
ALTER TABLE procurement.receiving_orders
  DROP CONSTRAINT IF EXISTS receiving_orders_receipt_number_unique;

ALTER TABLE procurement.receiving_orders
  DROP CONSTRAINT IF EXISTS receiving_orders_receipt_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS receiving_orders_receipt_number_active_uidx
  ON procurement.receiving_orders (receipt_number)
  WHERE status <> 'cancelled';

-- 4. ap_payments.payment_number
--    Uses voided_at IS NULL (not status enum) because voided_at is the
--    canonical "this payment is dead" signal — it's set atomically on void
--    and is what recalculateInvoiceBalance uses to exclude voided payments
--    from balance sums (see ap-ledger.service.ts:183).
ALTER TABLE procurement.ap_payments
  DROP CONSTRAINT IF EXISTS ap_payments_payment_number_unique;

ALTER TABLE procurement.ap_payments
  DROP CONSTRAINT IF EXISTS ap_payments_payment_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS ap_payments_payment_number_active_uidx
  ON procurement.ap_payments (payment_number)
  WHERE voided_at IS NULL;

COMMIT;
