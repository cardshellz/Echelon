/** Fixed SQL only. Every identity, alias and rejection limit is parameterized.
 * Relations are read separately so joins cannot multiply entitlement claims. */
export const inspectionQueries = Object.freeze({
  shops: `SELECT c.id AS "channelId", cc.id AS "connectionId", c.name AS "displayName",
    LOWER(BTRIM(cc.shop_domain)) AS "shopDomain", c.type, c.provider, c.status,
    (SELECT COUNT(*)::text FROM channels.channel_connections all_cc WHERE all_cc.channel_id = c.id) AS "connectionCount",
    (NULLIF(BTRIM(cc.access_token), '') IS NOT NULL) AS "hasCredentials",
    (LOWER(COALESCE(c.shipping_config #>> '{dropship,role}', '')) = 'oms'
      OR LOWER(COALESCE(c.shipping_config #>> '{dropship,omsChannel}', 'false')) = 'true'
      OR EXISTS (SELECT 1 FROM channels.channel_connections dcc WHERE dcc.channel_id = c.id AND (
        LOWER(COALESCE(dcc.metadata #>> '{dropship,role}', '')) = 'oms'
        OR LOWER(COALESCE(dcc.metadata #>> '{features,dropshipOms}', 'false')) = 'true'
        OR LOWER(COALESCE(dcc.metadata #>> '{features,dropship_oms}', 'false')) = 'true'
      ))) AS "isDropship"
    FROM channels.channels c JOIN channels.channel_connections cc ON cc.channel_id = c.id
    WHERE LOWER(BTRIM(cc.shop_domain)) = ANY($1::text[])
    ORDER BY c.id, cc.id LIMIT $2`,

  // OMS's naive timestamp columns are written/read as UTC by Drizzle's
  // PgTimestamp mapping. Promote them to timestamptz before node-postgres can
  // reinterpret them in the Node host's local time zone. Carrier tables below
  // already use timestamptz and must retain their stored instants unchanged.
  order: `SELECT oo.id AS "omsOrderId", oo.channel_id AS "channelId",
    oo.external_order_id AS "externalOrderId", oo.external_order_number AS "externalOrderNumber",
    oo.ordered_at AT TIME ZONE 'UTC' AS "purchasedAt", oo.ship_to_country AS "shipToCountry",
    oo.cancelled_at AT TIME ZONE 'UTC' AS "cancelledAt",
    EXISTS (SELECT 1 FROM dropship.dropship_order_intake doi WHERE doi.oms_order_id = oo.id) AS "isDropship"
    FROM oms.oms_orders oo WHERE oo.channel_id = $1 AND oo.external_order_number = ANY($2::text[])
    ORDER BY oo.id LIMIT 2`,

  lines: `SELECT line.id AS "omsOrderLineId", line.external_line_item_id AS "externalLineItemId",
    line.title, line.variant_title AS "variantTitle", line.sku, line.quantity, line.requires_shipping AS "requiresShipping",
    variant.weight_grams::text AS "unitWeightGrams"
    FROM oms.oms_order_lines line LEFT JOIN catalog.product_variants variant ON variant.id = line.product_variant_id
    WHERE line.order_id = $1 ORDER BY line.id LIMIT $2`,

  wmsItems: `SELECT wi.id AS "wmsOrderItemId", wo.id AS "wmsOrderId", wi.oms_order_line_id AS "omsOrderLineId",
    wo.channel_id AS "channelId", wo.source, wo.oms_fulfillment_order_id AS "omsOrderReference",
    wo.source_table_id AS "legacyOrderReference", wo.external_order_id AS "externalOrderId",
    wi.source_item_id AS "externalLineItemId", wi.quantity, wi.fulfilled_quantity AS "fulfilledQuantity",
    wo.warehouse_status AS "warehouseStatus"
    FROM wms.order_items wi JOIN wms.orders wo ON wo.id = wi.order_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = wi.oms_order_line_id
    WHERE ol.order_id = $1 OR wo.oms_fulfillment_order_id = $2
      OR wo.source_table_id = $2
    ORDER BY wo.id, wi.id LIMIT $3`,

  rootClaims: `SELECT aa.id AS "claimId", aa.authorization_id AS "authorizationId",
    aa.authorization_line_id AS "authorizationLineId", a.channel_id AS "channelId", a.oms_order_id AS "omsOrderId",
    al.oms_order_line_id AS "omsOrderLineId", al.external_line_item_id AS "externalLineItemId",
    aa.wms_order_item_id AS "wmsOrderItemId", aa.fulfillment_id AS "fulfillmentId",
    aa.fulfillment_line_item_id AS "fulfillmentLineItemId", aa.quantity
    FROM returns.customer_return_authorization_allocations aa
    JOIN returns.customer_return_authorization_lines al ON al.id = aa.authorization_line_id
    JOIN returns.customer_return_authorizations a ON a.id = aa.authorization_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = al.oms_order_line_id
    WHERE a.oms_order_id = $1 OR ol.order_id = $1 OR aa.wms_order_item_id = ANY($2::int[])
    ORDER BY aa.id LIMIT $3`,

  // Cases are mirrors of these exact return_item rows, not additional claims.
  // Include contradictory line/parent links so they fail closed instead of disappearing.
  legacyClaims: `SELECT ri.id AS "returnItemId", r.id AS "returnId", r.order_id AS "wmsOrderId",
    ri.order_item_id AS "wmsOrderItemId", ri.oms_order_line_id AS "omsOrderLineId",
    ri.external_line_item_id AS "externalLineItemId", ri.expected_qty AS "expectedQuantity",
    ri.received_qty AS "receivedQuantity", ri.status, r.refund_external_id AS "refundExternalId", r.source
    FROM wms.return_items ri JOIN wms.returns r ON r.id = ri.return_id
    JOIN wms.orders wo ON wo.id = r.order_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = ri.oms_order_line_id
    WHERE ol.order_id = $1 OR wo.oms_fulfillment_order_id = $2
      OR wo.source_table_id = $2
      OR ri.order_item_id = ANY($3::int[]) OR r.order_id = ANY($4::int[])
    ORDER BY ri.id LIMIT $5`,

  unallocatedReturns: `SELECT r.id AS "returnId", r.order_id AS "wmsOrderId", r.status,
    r.refund_external_id AS "refundExternalId"
    FROM wms.returns r JOIN wms.orders wo ON wo.id = r.order_id
    WHERE (wo.oms_fulfillment_order_id = $1 OR wo.source_table_id = $1
      OR r.order_id = ANY($2::int[]))
      AND NOT EXISTS (SELECT 1 FROM wms.return_items ri WHERE ri.return_id = r.id)
    ORDER BY r.id LIMIT $3`,

  inventoryReturns: `SELECT tx.id AS "transactionId", tx.order_id AS "wmsOrderId", tx.order_item_id AS "wmsOrderItemId",
    tx.variant_qty_delta AS "quantityDelta", tx.created_at AT TIME ZONE 'UTC' AS "occurredAt"
    FROM inventory.inventory_transactions tx LEFT JOIN wms.orders wo ON wo.id = tx.order_id
    WHERE tx.transaction_type = 'return'
      AND (tx.order_id = ANY($1::int[]) OR tx.order_item_id = ANY($2::int[])
        OR wo.oms_fulfillment_order_id = $3 OR wo.source_table_id = $3)
    ORDER BY tx.id LIMIT $4`,

  bindings: `SELECT * FROM (
    SELECT 'receipt'::text AS kind, ri.id AS "bindingId", r.id AS "parentId", r.source_provider AS provider,
      r.source_channel_id AS "sourceChannelId", r.source_order_id AS "sourceOrderId",
      r.source_fulfillment_id AS "fulfillmentId", ri.source_fulfillment_line_id AS "providerFulfillmentLineId",
      ri.channel_order_line_id AS "purchasedLineId", ri.oms_order_line_id AS "omsOrderLineId",
      ri.wms_order_item_id AS "wmsOrderItemId", r.physical_shipment_id AS "physicalShipmentId",
      ri.physical_shipment_item_id AS "physicalShipmentItemId", ri.quantity,
      r.processing_status AS status, r.source
    FROM oms.channel_fulfillment_receipts r JOIN oms.channel_fulfillment_receipt_items ri ON ri.receipt_id = r.id
    WHERE r.oms_order_id = $1 OR (r.source_channel_id = $2 AND r.source_order_id = ANY($3::text[]))
    UNION ALL
    SELECT 'push'::text, pi.id, p.id, p.channel_provider, oo.channel_id, oo.external_order_id,
      p.channel_fulfillment_id, NULL::varchar, pi.channel_order_line_id, pi.oms_order_line_id,
      physical.wms_order_item_id, p.physical_shipment_id, pi.physical_shipment_item_id,
      pi.quantity_pushed, p.push_status, 'channel_fulfillment_push'::text
    FROM oms.channel_fulfillment_pushes p JOIN oms.channel_fulfillment_push_items pi ON pi.channel_fulfillment_push_id = p.id
    JOIN oms.oms_orders oo ON oo.id = p.oms_order_id
    LEFT JOIN wms.physical_shipment_items physical ON physical.id = pi.physical_shipment_item_id
    WHERE p.oms_order_id = $1
    ) evidence ORDER BY kind, "bindingId" LIMIT $4`,

  // Expand exact candidate packages to ALL their retained contents. A box with
  // another order's or unattributable contents must not become a partial box option.
  packageItems: `WITH candidate_packages AS (
    SELECT DISTINCT candidate.physical_shipment_id FROM wms.physical_shipment_items candidate
    LEFT JOIN wms.fulfillment_plan_lines plan ON plan.id = candidate.fulfillment_plan_line_id
    WHERE candidate.wms_order_item_id = ANY($1::int[]) OR candidate.replacement_for_order_item_id = ANY($1::int[])
      OR plan.oms_order_line_id = ANY($2::bigint[]) OR candidate.id = ANY($3::bigint[])
      OR candidate.physical_shipment_id = ANY($4::bigint[])
    ) SELECT item.id AS "physicalShipmentItemId", item.physical_shipment_id AS "physicalShipmentId",
    item.wms_order_item_id AS "wmsOrderItemId", plan.oms_order_line_id AS "omsOrderLineId",
    item.legacy_wms_shipment_item_id AS "legacyShipmentItemId", legacy.shipment_id AS "legacyShipmentId",
    item.shipment_item_purpose AS purpose, item.replacement_for_order_item_id AS "replacementForOrderItemId",
    item.correction_for_physical_shipment_item_id AS "correctionForPhysicalShipmentItemId",
    item.quantity_shipped AS "originalQuantity", COALESCE(effective.quantity_shipped, 0) AS "effectiveQuantity",
    shipment.status, shipment.provider, shipment.provider_physical_shipment_id AS "providerPhysicalShipmentId",
    shipment.tracking_number AS "trackingNumber", shipment.carrier
    FROM wms.physical_shipment_items item JOIN wms.physical_shipments shipment ON shipment.id = item.physical_shipment_id
    LEFT JOIN wms.effective_physical_shipment_items effective ON effective.id = item.id
    LEFT JOIN wms.fulfillment_plan_lines plan ON plan.id = item.fulfillment_plan_line_id
    LEFT JOIN wms.outbound_shipment_items legacy ON legacy.id = item.legacy_wms_shipment_item_id
    WHERE item.physical_shipment_id IN (SELECT physical_shipment_id FROM candidate_packages)
    ORDER BY item.id LIMIT $5`,

  // Only an exact physical-package link is emitted. Request/order-level and
  // tracking-string matches do not prove which purchased quantities were inside.
  labels: `SELECT link.id AS "linkId", label.id AS "labelId", link.physical_shipment_id AS "physicalShipmentId",
    label.provider, label.provider_label_id AS "providerLabelId", label.tracking_number AS "trackingNumber",
    label.normalized_tracking_number AS "normalizedTrackingNumber", label.carrier,
    label.label_status AS status, label.label_direction AS direction, label.voided_at AS "voidedAt"
    FROM wms.shipping_provider_label_links link JOIN wms.shipping_provider_labels label ON label.id = link.shipping_provider_label_id
    WHERE link.physical_shipment_id = ANY($1::bigint[]) ORDER BY link.id LIMIT $2`,

  // State's current match is authoritative; an old successful attempt is not.
  events: `SELECT event.id AS "eventId", match.id AS "matchId", match.shipping_provider_label_id AS "labelId",
    event.canonical_status AS "canonicalStatus", event.dispatch_evidence AS "dispatchEvidence",
    event.event_occurred_at AS "occurredAt", event.actual_delivery_at AS "actualDeliveryAt", event.received_at AS "receivedAt"
    FROM wms.carrier_tracking_reconciliation_state state
    JOIN wms.carrier_tracking_event_matches match ON match.id = state.last_match_attempt_id
      AND match.carrier_tracking_event_id = state.carrier_tracking_event_id
    JOIN wms.carrier_tracking_events event ON event.id = state.carrier_tracking_event_id
    WHERE state.last_match_status = 'matched' AND match.match_status = 'matched'
      AND state.last_candidate_count = 1 AND match.candidate_count = 1
      AND match.shipping_provider_label_id = ANY($1::bigint[])
    ORDER BY event.id, match.id LIMIT $2`,
});
