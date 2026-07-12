-- Line-level Shopify refund authority and expected-return identity.
--
-- A refund is order-level financial evidence plus per-line disposition facts.
-- Physical returns are order-level RMAs and may span multiple outbound
-- shipments, so shipment_id can no longer be a required parent identity.

ALTER TABLE wms.returns
  ALTER COLUMN shipment_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'closed',
  ADD COLUMN IF NOT EXISTS source_event_key VARCHAR(250);

DO $$
DECLARE
  existing_constraint_name TEXT;
BEGIN
  SELECT constraint_row.conname
  INTO existing_constraint_name
  FROM pg_constraint constraint_row
  JOIN pg_attribute column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attnum = ANY(constraint_row.conkey)
  WHERE constraint_row.contype = 'f'
    AND constraint_row.conrelid = 'wms.returns'::regclass
    AND column_row.attname = 'shipment_id'
  LIMIT 1;

  IF existing_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE wms.returns DROP CONSTRAINT %I',
      existing_constraint_name
    );
  END IF;

  ALTER TABLE wms.returns
    ADD CONSTRAINT wms_returns_shipment_id_fkey
    FOREIGN KEY (shipment_id)
    REFERENCES wms.outbound_shipments(id)
    ON DELETE SET NULL;
END $$;

CREATE TABLE IF NOT EXISTS wms.return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id BIGINT NOT NULL REFERENCES wms.returns(id) ON DELETE CASCADE,
  order_item_id INTEGER REFERENCES wms.order_items(id) ON DELETE SET NULL,
  oms_order_line_id BIGINT,
  external_line_item_id VARCHAR(100),
  sku VARCHAR(100),
  expected_qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  restock_policy VARCHAR(20),
  location_id VARCHAR(100),
  condition VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'expected',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN wms.returns.source_event_key IS
  'Durable provider event identity for future return writers; Shopify format is shopify:refund:<refund_id>:order:<wms_order_id>.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_source_event_key
  ON wms.returns (source_event_key)
  WHERE NULLIF(BTRIM(source_event_key), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_return
  ON wms.return_items(return_id);

CREATE INDEX IF NOT EXISTS idx_return_items_order_item
  ON wms.return_items(order_item_id);

CREATE INDEX IF NOT EXISTS idx_returns_status_open
  ON wms.returns(status)
  WHERE status <> 'closed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_returns_status_chk'
      AND conrelid = 'wms.returns'::regclass
  ) THEN
    ALTER TABLE wms.returns
      ADD CONSTRAINT wms_returns_status_chk
      CHECK (status IN ('expected', 'partially_received', 'received', 'closed'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_return_items_quantity_chk'
      AND conrelid = 'wms.return_items'::regclass
  ) THEN
    ALTER TABLE wms.return_items
      ADD CONSTRAINT wms_return_items_quantity_chk
      CHECK (
        expected_qty > 0
        AND received_qty >= 0
        AND received_qty <= expected_qty
      )
      NOT VALID;
  END IF;
END $$;
