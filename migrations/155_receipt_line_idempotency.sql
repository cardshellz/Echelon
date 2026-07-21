-- Receipt inventory posting is idempotent per receiving line.
--
-- The previous key used (receiving_order_id, product_variant_id, to_location_id).
-- Two legitimate lines for the same variant and location therefore caused the
-- second line to be treated as a replay and silently skipped. Historical rows
-- remain protected by the legacy key when receiving_line_id is NULL; all new
-- receiving closes persist the exact receiving line identity.

ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS receiving_line_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_transactions_receiving_line_id_fkey'
      AND conrelid = 'inventory.inventory_transactions'::regclass
  ) THEN
    ALTER TABLE inventory.inventory_transactions
      ADD CONSTRAINT inventory_transactions_receiving_line_id_fkey
      FOREIGN KEY (receiving_line_id)
      REFERENCES procurement.receiving_lines(id);
  END IF;
END $$;

DROP INDEX IF EXISTS inventory.uq_inventory_transactions_receipt_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_line_dedup
  ON inventory.inventory_transactions (receiving_line_id)
  WHERE transaction_type = 'receipt'
    AND receiving_line_id IS NOT NULL
    AND voided_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_legacy_dedup
  ON inventory.inventory_transactions (receiving_order_id, product_variant_id, to_location_id)
  WHERE transaction_type = 'receipt'
    AND receiving_line_id IS NULL
    AND receiving_order_id IS NOT NULL
    AND product_variant_id IS NOT NULL
    AND to_location_id IS NOT NULL
    AND voided_at IS NULL;

COMMENT ON COLUMN inventory.inventory_transactions.receiving_line_id IS
  'Exact receiving line whose close command created this receipt ledger row; authoritative idempotency identity for new receipts.';
