-- First-class authority for replacement/reship physical shipments.
--
-- A replacement consumes inventory again but must not fulfill the customer's
-- ordered quantity a second time. Replacement shipment items therefore retain
-- lineage through replacement_for_order_item_id while order_item_id stays NULL.

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS shipment_purpose VARCHAR(30) NOT NULL DEFAULT 'customer_fulfillment',
  ADD COLUMN IF NOT EXISTS replaces_shipment_id INTEGER,
  ADD COLUMN IF NOT EXISTS replacement_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS replacement_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replacement_authorized_by VARCHAR(120),
  ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(200);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipments_purpose_chk'
      AND conrelid = 'wms.outbound_shipments'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD CONSTRAINT outbound_shipments_purpose_chk
      CHECK (shipment_purpose IN ('customer_fulfillment', 'replacement'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipments_replacement_authority_chk'
      AND conrelid = 'wms.outbound_shipments'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD CONSTRAINT outbound_shipments_replacement_authority_chk
      CHECK (
        shipment_purpose <> 'replacement'
        OR (
          replaces_shipment_id IS NOT NULL
          AND NULLIF(BTRIM(replacement_reason), '') IS NOT NULL
          AND replacement_authorized_at IS NOT NULL
          AND NULLIF(BTRIM(replacement_authorized_by), '') IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipments_replaces_shipment_fk'
      AND conrelid = 'wms.outbound_shipments'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD CONSTRAINT outbound_shipments_replaces_shipment_fk
      FOREIGN KEY (replaces_shipment_id)
      REFERENCES wms.outbound_shipments(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outbound_shipments_replaces_shipment
  ON wms.outbound_shipments (replaces_shipment_id)
  WHERE replaces_shipment_id IS NOT NULL;

-- A replacement is a deliberately separate physical package and may coexist
-- with another active fulfillment shipment on the order.
DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_per_order;

CREATE UNIQUE INDEX uq_outbound_shipments_active_per_order
  ON wms.outbound_shipments USING btree (order_id)
  WHERE (
    status = ANY (ARRAY[
      'planned'::wms.shipment_status,
      'queued'::wms.shipment_status,
      'labeled'::wms.shipment_status,
      'on_hold'::wms.shipment_status
    ])
    AND shipment_purpose = 'customer_fulfillment'
    AND (COALESCE(source, ''::character varying))::text <> ALL ((ARRAY[
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split',
      'shipstation_reship',
      'shipstation_reship_adopted',
      'line_item_hold'
    ])::text[])
  );

ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN IF NOT EXISTS replacement_for_order_item_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipment_items_replacement_line_fk'
      AND conrelid = 'wms.outbound_shipment_items'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT outbound_shipment_items_replacement_line_fk
      FOREIGN KEY (replacement_for_order_item_id)
      REFERENCES wms.order_items(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipment_items_authority_link_chk'
      AND conrelid = 'wms.outbound_shipment_items'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT outbound_shipment_items_authority_link_chk
      CHECK (order_item_id IS NULL OR replacement_for_order_item_id IS NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipment_items_replacement_line
  ON wms.outbound_shipment_items (shipment_id, replacement_for_order_item_id)
  WHERE replacement_for_order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_replacement_line
  ON wms.outbound_shipment_items (replacement_for_order_item_id)
  WHERE replacement_for_order_item_id IS NOT NULL;
