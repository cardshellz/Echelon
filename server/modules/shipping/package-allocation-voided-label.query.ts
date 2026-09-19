/** Infrastructure facts only. The domain decides whether a label can be excluded. */
export const VOIDED_LABEL_POSTING_FACTS_REQUIRED_RELATIONS = Object.freeze([
  "oms.channel_fulfillment_pushes", "oms.channel_fulfillment_receipts", "oms.oms_orders", "channels.channels",
  "wms.fulfillment_plans", "wms.outbound_shipments", "wms.package_allocation_package_bindings",
  "wms.physical_shipments", "wms.shipment_requests", "wms.shipping_engine_order_requests",
  "wms.shipping_provider_label_links", "wms.shipping_provider_labels",
]);

// The caller bounds label ids and holds label/source locks for writes. Each
// footprint lookup uses provider identity, linked ids, or indexed order scopes;
// it never scans all orders or assumes a shared order means shared contents.
export const VOIDED_LABEL_POSTING_FACTS_SQL = `
WITH labels AS MATERIALIZED (
  SELECT id, provider, provider_label_id, tracking_number
  FROM wms.shipping_provider_labels WHERE id = ANY($1::bigint[])
), request_links AS (
  SELECT link.shipping_provider_label_id AS label_id, request.id AS request_id
  FROM labels JOIN wms.shipping_provider_label_links link ON link.shipping_provider_label_id = labels.id
  JOIN wms.shipment_requests request ON request.id = link.shipment_request_id
  UNION
  SELECT link.shipping_provider_label_id, mapping.shipment_request_id
  FROM labels JOIN wms.shipping_provider_label_links link ON link.shipping_provider_label_id = labels.id
  JOIN wms.shipping_engine_order_requests mapping ON mapping.shipping_engine_order_id = link.shipping_engine_order_id
  UNION
  SELECT link.shipping_provider_label_id, request.id
  FROM labels JOIN wms.shipping_provider_label_links link ON link.shipping_provider_label_id = labels.id
  JOIN wms.shipment_requests request ON request.legacy_wms_shipment_id = link.legacy_wms_shipment_id
), order_scopes AS MATERIALIZED (
  SELECT DISTINCT link.label_id, request.wms_order_id, plan.oms_order_id,
    sales_order.external_order_id, sales_order.channel_id, channel.provider AS channel_provider
  FROM request_links link JOIN wms.shipment_requests request ON request.id = link.request_id
  JOIN wms.fulfillment_plans plan ON plan.id = request.fulfillment_plan_id
  JOIN oms.oms_orders sales_order ON sales_order.id = plan.oms_order_id
  JOIN channels.channels channel ON channel.id = sales_order.channel_id
  WHERE request.wms_order_id IS NOT NULL AND NULLIF(BTRIM(sales_order.external_order_id), '') IS NOT NULL
)
SELECT labels.id::text AS label_id, labels.provider, labels.provider_label_id, labels.tracking_number,
  EXISTS (SELECT 1 FROM order_scopes scope WHERE scope.label_id = labels.id) AS has_order_scope,
  EXISTS (SELECT 1 FROM wms.package_allocation_package_bindings binding
    WHERE binding.provider = labels.provider AND binding.provider_physical_shipment_id = labels.provider_label_id) AS has_allocation_binding,
  (EXISTS (SELECT 1 FROM wms.physical_shipments package
     WHERE package.provider = labels.provider AND package.provider_physical_shipment_id = labels.provider_label_id)
   OR EXISTS (SELECT 1 FROM wms.physical_shipments package WHERE package.tracking_number = labels.tracking_number)
   OR EXISTS (SELECT 1 FROM wms.shipping_provider_label_links link
     WHERE link.shipping_provider_label_id = labels.id AND link.physical_shipment_id IS NOT NULL)) AS has_physical_package,
  EXISTS (SELECT 1 FROM order_scopes scope JOIN wms.outbound_shipments shipment ON shipment.order_id = scope.wms_order_id
    WHERE scope.label_id = labels.id AND (
      shipment.external_fulfillment_id = 'shipstation_shipment:' || labels.provider_label_id
      OR shipment.engine_shipment_ref = labels.provider_label_id
      OR upper(regexp_replace(COALESCE(shipment.tracking_number, ''), '\\s', '', 'g')) = upper(regexp_replace(labels.tracking_number, '\\s', '', 'g'))
    )) AS has_legacy_package,
  EXISTS (SELECT 1 FROM order_scopes scope JOIN oms.channel_fulfillment_pushes command ON command.oms_order_id = scope.oms_order_id
    WHERE scope.label_id = labels.id
      AND upper(regexp_replace(COALESCE(command.tracking_number, ''), '\\s', '', 'g')) = upper(regexp_replace(labels.tracking_number, '\\s', '', 'g'))
    ) AS has_channel_command,
  -- Use the provider/order index, including receipts not yet mapped to an OMS
  -- order. Shopify ingress accepts numeric ids while OMS may store a GID.
  EXISTS (SELECT 1 FROM order_scopes scope JOIN oms.channel_fulfillment_receipts receipt
      ON receipt.source_provider = scope.channel_provider
      AND receipt.source_order_id = ANY(CASE WHEN scope.channel_provider = 'shopify' THEN ARRAY[
        scope.external_order_id, regexp_replace(scope.external_order_id, '^gid://shopify/Order/', ''),
        'gid://shopify/Order/' || regexp_replace(scope.external_order_id, '^gid://shopify/Order/', '')
      ] ELSE ARRAY[scope.external_order_id] END)
    WHERE scope.label_id = labels.id
      AND (receipt.source_channel_id IS NULL OR receipt.source_channel_id = scope.channel_id)
      AND upper(regexp_replace(COALESCE(receipt.tracking_number, ''), '\\s', '', 'g')) = upper(regexp_replace(labels.tracking_number, '\\s', '', 'g'))
    ) AS has_channel_receipt
FROM labels ORDER BY labels.id`;
