ALTER TABLE IF EXISTS dropship.dropship_marketplace_tracking_pushes
  ADD COLUMN IF NOT EXISTS wms_shipment_id integer
    REFERENCES wms.outbound_shipments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dropship_tracking_push_wms_shipment_idx
  ON dropship.dropship_marketplace_tracking_pushes (wms_shipment_id)
  WHERE wms_shipment_id IS NOT NULL;
