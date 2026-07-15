-- First-class physical authority for a different/free SKU sent against an
-- order without turning that SKU into customer demand or fulfillment.

ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN IF NOT EXISTS shipment_item_purpose VARCHAR(30);

UPDATE wms.outbound_shipment_items item
SET shipment_item_purpose = CASE
  WHEN item.replacement_for_order_item_id IS NOT NULL THEN 'replacement'
  WHEN item.order_item_id IS NOT NULL THEN 'customer_fulfillment'
  ELSE 'unclassified'
END
WHERE item.shipment_item_purpose IS NULL;

ALTER TABLE wms.outbound_shipment_items
  ALTER COLUMN shipment_item_purpose SET DEFAULT 'customer_fulfillment',
  ALTER COLUMN shipment_item_purpose SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipment_items_purpose_chk'
      AND conrelid = 'wms.outbound_shipment_items'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT outbound_shipment_items_purpose_chk
      CHECK (shipment_item_purpose IN (
        'customer_fulfillment', 'replacement', 'concession', 'unclassified'
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipment_items_concession_variant
  ON wms.outbound_shipment_items (shipment_id, product_variant_id)
  WHERE shipment_item_purpose = 'concession';

ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS shipment_item_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_transactions_shipment_item_fk'
      AND conrelid = 'inventory.inventory_transactions'::regclass
  ) THEN
    ALTER TABLE inventory.inventory_transactions
      ADD CONSTRAINT inventory_transactions_shipment_item_fk
      FOREIGN KEY (shipment_item_id)
      REFERENCES wms.outbound_shipment_items(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_ship_item_dedup
  ON inventory.inventory_transactions (shipment_id, shipment_item_id)
  WHERE transaction_type = 'ship'
    AND shipment_id IS NOT NULL
    AND shipment_item_id IS NOT NULL;
