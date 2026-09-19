-- Keep immutable provider/source-line identity after a refund removes current
-- commercial demand. NULL preserves the pre-migration meaning of qty.
ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN commercial_requested_qty integer;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_commercial_requested_qty_chk
  CHECK (
    commercial_requested_qty IS NULL
    OR commercial_requested_qty BETWEEN 0 AND qty
  );
