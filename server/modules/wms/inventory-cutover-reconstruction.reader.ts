import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { TERMINAL_WMS_DEMAND_STATUSES } from "@shared/enums/order-status";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

const MAX_ROWS = 100_000;
export async function readWmsCutoverShipmentReviews(client: PoolClient): Promise<CutoverReconstructionEvidence["shipmentReviewEvidence"]> {
  const reviews = (await client.query(`SELECT id::text, status, to_jsonb(shipment) AS evidence
    FROM wms.outbound_shipments shipment WHERE requires_review=true ORDER BY id LIMIT 100001`)).rows;
  if (reviews.length > MAX_ROWS) throw new Error("WMS_CUTOVER_REVIEW_CENSUS_LIMIT_EXCEEDED");
  return reviews.map((row) => ({ id: row.id,kind: "outbound_shipment_review",status: row.status,
    evidenceHash: createHash("sha256").update(canonicalJson(row.evidence)).digest("hex") }));
}
/** WMS-owned census includes terminal residuals and orphan/review package rows. */
export async function readWmsCutoverReconstruction(client: PoolClient, residualOrderIds: number[], residualItemIds: number[]): Promise<Pick<CutoverReconstructionEvidence,
  "orders" | "items" | "sourceItems" | "physicalItems" | "buildDemands">> {
  const read = async (query: string, args: unknown[]) => {
    const result = await client.query(query, [...args, MAX_ROWS + 1]);
    if (result.rows.length > MAX_ROWS) throw new Error("WMS_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED");
    return result.rows;
  };
  // A residual journal's order header may be missing or disagree with its item.
  // Capture both identities; the planner must review, never repair, that conflict.
  const orders = await read(`SELECT id, warehouse_id AS "warehouseId", warehouse_status AS status,
    on_hold AS "onHold", channel_id AS "channelId", source, external_order_id AS "externalOrderId",
    oms_fulfillment_order_id AS "omsFulfillmentOrderId", fulfillment_partition_key AS "fulfillmentPartitionKey"
    FROM wms.orders WHERE warehouse_status IS NULL OR NOT (warehouse_status = ANY($2::text[]))
      OR id=ANY($1::integer[])
      OR id IN (SELECT order_id FROM wms.order_items WHERE id=ANY($3::integer[]))
    ORDER BY id LIMIT $4`, [residualOrderIds, TERMINAL_WMS_DEMAND_STATUSES, residualItemIds]);
  const orderIds = orders.map((row) => row.id);
  const items = await read(`SELECT id, order_id AS "orderId", oms_order_line_id::text AS "omsOrderLineId",
    source_item_id AS "sourceItemId", sku, product_id AS "productId", quantity,
    picked_quantity AS "pickedQuantity", fulfilled_quantity AS "fulfilledQuantity", status,
    on_hold AS "onHold", requires_shipping AS "requiresShipping", location, short_reason AS "shortReason"
    FROM wms.order_items WHERE order_id=ANY($1::integer[]) OR id=ANY($2::integer[])
    ORDER BY order_id,id LIMIT $3`, [orderIds, residualItemIds]);
  const itemIds = items.map((row) => row.id);
  const sourceItems = await read(`SELECT source.id, source.shipment_id AS "shipmentId", shipment.order_id AS "headerOrderId",
    source.order_item_id AS "orderItemId", source.replacement_for_order_item_id AS "replacementForOrderItemId",
    source.correction_for_shipment_item_id AS "correctionForShipmentItemId", source.product_variant_id AS "productVariantId",
    source.qty AS quantity, source.shipment_item_purpose AS purpose, source.from_location_id AS "fromLocationId",
    shipment.status AS "shipmentStatus", shipment.held AS "shipmentHeld"
    FROM wms.outbound_shipment_items source LEFT JOIN wms.outbound_shipments shipment ON shipment.id=source.shipment_id
    LEFT JOIN wms.order_items item ON item.id=source.order_item_id
    WHERE shipment.order_id=ANY($1::integer[]) OR source.order_item_id=ANY($2::integer[])
      OR source.replacement_for_order_item_id=ANY($2::integer[]) OR item.id IS NULL OR shipment.id IS NULL
      OR shipment.requires_review = true
    ORDER BY source.id LIMIT $3`, [orderIds, itemIds]);
  const physicalItems = await read(`SELECT item.id::text AS id, item.physical_shipment_id::text AS "physicalShipmentId",
    item.wms_order_item_id AS "orderItemId", item.replacement_for_order_item_id AS "replacementForOrderItemId",
    item.legacy_wms_shipment_item_id AS "legacySourceShipmentItemId", item.package_allocation_entry_id::text AS "packageAllocationEntryId",
    item.product_variant_id AS "productVariantId", item.sku, item.quantity_shipped AS "originalQuantity",
    COALESCE(adjustment.quantity_delta,0) AS "adjustmentQuantity",
    (item.quantity_shipped::bigint+COALESCE(adjustment.quantity_delta,0))::text AS "effectiveQuantity",
    item.shipment_item_purpose AS purpose, package.status AS "packageStatus"
    FROM wms.physical_shipment_items item LEFT JOIN wms.physical_shipments package ON package.id=item.physical_shipment_id
    LEFT JOIN wms.physical_shipment_item_quantity_adjustments adjustment ON adjustment.physical_shipment_item_id=item.id
    LEFT JOIN wms.order_items demand ON demand.id=item.wms_order_item_id
    WHERE item.wms_order_item_id=ANY($1::integer[]) OR item.replacement_for_order_item_id=ANY($1::integer[])
      OR item.legacy_wms_shipment_item_id=ANY($2::integer[]) OR demand.id IS NULL OR package.id IS NULL
      OR package.status = 'review'
    ORDER BY item.id LIMIT $3`, [itemIds, sourceItems.map((row) => row.id)]);
  const buildDemands = await read(`SELECT id, order_id AS "orderId", order_item_id AS "orderItemId",
    target_variant_id AS "targetVariantId", root_build_order_id AS "rootBuildOrderId", status,
    requested_qty::text AS "requestedQty", promised_qty::text AS "promisedQty"
    FROM wms.order_build_demands WHERE status IN ('planning','awaiting_build') OR order_id=ANY($1::integer[])
    ORDER BY id LIMIT $2`, [orderIds]);
  return { orders, items, sourceItems, physicalItems, buildDemands };
}
