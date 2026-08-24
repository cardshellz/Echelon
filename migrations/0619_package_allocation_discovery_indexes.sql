-- Support bounded package-allocation relationship discovery from WMS source
-- identities. Existing label-link uniqueness indexes are label-first and do
-- not support the reverse request/order/physical/legacy lookups used here.

CREATE INDEX idx_physical_shipment_items_request_item_lookup
  ON wms.physical_shipment_items (shipment_request_item_id, physical_shipment_id)
  WHERE shipment_request_item_id IS NOT NULL;

CREATE INDEX idx_physical_shipments_engine_order_lookup
  ON wms.physical_shipments (shipping_engine_order_id, id)
  WHERE shipping_engine_order_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_label_links_request_lookup
  ON wms.shipping_provider_label_links (shipment_request_id, shipping_provider_label_id)
  WHERE shipment_request_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_label_links_engine_order_lookup
  ON wms.shipping_provider_label_links (shipping_engine_order_id, shipping_provider_label_id)
  WHERE shipping_engine_order_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_label_links_physical_lookup
  ON wms.shipping_provider_label_links (physical_shipment_id, shipping_provider_label_id)
  WHERE physical_shipment_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_label_links_legacy_lookup
  ON wms.shipping_provider_label_links (legacy_wms_shipment_id, shipping_provider_label_id)
  WHERE legacy_wms_shipment_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_labels_provider_order_id_lookup
  ON wms.shipping_provider_labels (provider, provider_order_id, id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX idx_shipping_provider_labels_provider_order_key_lookup
  ON wms.shipping_provider_labels (provider, provider_order_key, id)
  WHERE provider_order_key IS NOT NULL;
