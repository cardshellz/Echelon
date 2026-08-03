-- Keep the background Control Tower waterfall inside its bounded statement
-- timeout. These indexes support shipment-scoped writeback evidence lookups;
-- they do not change fulfillment authority or operational state.

CREATE INDEX IF NOT EXISTS idx_oms_order_events_writeback_shipment
  ON oms.oms_order_events (
    order_id,
    event_type,
    ((details ->> 'wmsShipmentId'))
  )
  WHERE event_type IN (
    'tracking_pushed',
    'shopify_fulfillment_pushed',
    'shopify_fulfillment_reconciled'
  );

CREATE INDEX IF NOT EXISTS idx_webhook_retry_internal_fulfillment_shipment_state
  ON oms.webhook_retry_queue (
    ((payload ->> 'shipmentId')),
    topic,
    status
  )
  WHERE provider = 'internal'
    AND topic IN ('shopify_fulfillment_push', 'delayed_tracking_push')
    AND status IN ('pending', 'dead')
    AND (payload ->> 'shipmentId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_push_items_physical_item
  ON oms.channel_fulfillment_push_items (
    physical_shipment_item_id,
    channel_fulfillment_push_id
  )
  WHERE physical_shipment_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipt_items_legacy_shipment_item
  ON oms.channel_fulfillment_receipt_items (
    legacy_wms_shipment_item_id,
    receipt_id
  )
  WHERE legacy_wms_shipment_item_id IS NOT NULL;
