-- Migration 143 introduced a closed purpose list before omission corrections
-- existed. Keep the coarse purpose constraint aligned with the authoritative
-- lineage constraint so valid correction rows can reach the lineage trigger.

ALTER TABLE wms.outbound_shipment_items
  DROP CONSTRAINT IF EXISTS outbound_shipment_items_purpose_chk;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_purpose_chk
  CHECK (shipment_item_purpose IN (
    'customer_fulfillment',
    'replacement',
    'concession',
    'omission_correction',
    'unclassified'
  )) NOT VALID;

ALTER TABLE wms.outbound_shipment_items
  VALIDATE CONSTRAINT outbound_shipment_items_purpose_chk;
