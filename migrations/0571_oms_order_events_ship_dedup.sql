-- D-DUPEVENT: Prevent duplicate shipment event rows on webhook replay.
-- recordShipmentEventV2 inserts into oms_order_events without any dedup,
-- so replayed SHIP_NOTIFY webhooks create duplicate event rows. This
-- partial unique index ensures only one event per (order, event_type,
-- wms_shipment_id) combination for shipment-related events.
--
-- The index uses the JSONB details->>'wmsShipmentId' field as the
-- discriminator since each SHIP_NOTIFY carries the WMS shipment ID.

CREATE UNIQUE INDEX IF NOT EXISTS uq_oms_order_events_shipment_dedup
  ON oms.oms_order_events (
    order_id,
    event_type,
    (details->>'wmsShipmentId')
  )
  WHERE event_type IN (
    'shipped_via_shipstation',
    'cancelled_via_shipstation',
    'voided_via_shipstation'
  )
  AND details->>'wmsShipmentId' IS NOT NULL;
