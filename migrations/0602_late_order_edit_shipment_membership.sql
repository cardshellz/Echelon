-- Late order edits can add paid, shippable demand after the original package
-- already exists in the shipping engine. Package membership must distinguish
-- rows that are locally planned from rows the provider has actually accepted.

ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN IF NOT EXISTS provider_membership_state varchar(30)
  NOT NULL DEFAULT 'authoritative';

ALTER TABLE wms.outbound_shipment_items
  DROP CONSTRAINT IF EXISTS outbound_shipment_items_provider_membership_state_chk;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_provider_membership_state_chk
  CHECK (provider_membership_state IN ('authoritative', 'pending_append'));

CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_pending_append
  ON wms.outbound_shipment_items (shipment_id, id)
  WHERE provider_membership_state = 'pending_append';

-- A residual late-edit package is intentionally allowed to coexist with the
-- original provider order after that order becomes non-editable.
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
      'line_item_hold',
      'late_order_edit'
    ])::text[])
  );
