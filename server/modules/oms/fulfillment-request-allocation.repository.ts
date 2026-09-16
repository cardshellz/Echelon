import { sql } from "drizzle-orm";
import {
  FulfillmentRequestAllocationError,
  resolveFulfillmentRequestAllocation,
  type FulfillmentRequestAllocationDecision,
  type FulfillmentRequestAllocationSnapshot,
  type FulfillmentRequestAllocationTarget,
  type FulfillmentRequestPhysicalSnapshot,
} from "./fulfillment-request-allocation.domain";

type Target = Omit<FulfillmentRequestAllocationTarget, "fulfillmentPlanId" | "fulfillmentPlanLineId">;
type QueryExecutor = { execute(query: ReturnType<typeof sql>): Promise<unknown> };
function rows<T>(result: unknown): T[] {
  const value = result as { rows?: T[] };
  if (!Array.isArray(value?.rows)) {
    throw new FulfillmentRequestAllocationError("CANONICAL_STATE_CONFLICT", "Request allocation query did not return rows", {});
  }
  return value.rows;
}

/** Called under the owner's plan lock for writes, or inside a read-only snapshot
 * for previews. This reader never changes requests, physical evidence or stock. */
export async function readFulfillmentRequestAllocation(
  tx: QueryExecutor,
  target: Target,
  shippingEngineOrderId: number | null,
  lockForUpdate: boolean,
): Promise<FulfillmentRequestAllocationDecision> {
  const planRows = rows<{
    plan_id: string; oms_order_id: string; line_id: string | null;
    wms_order_item_id: number | null; quantity_planned: number | null;
  }>(await tx.execute(sql`
    SELECT plan.id AS plan_id, plan.oms_order_id, line.id AS line_id,
      line.wms_order_item_id, line.quantity_planned
    FROM wms.fulfillment_plans AS plan
    LEFT JOIN wms.fulfillment_plan_lines AS line
      ON line.fulfillment_plan_id = plan.id AND line.oms_order_line_id = ${target.omsOrderLineId}
    WHERE plan.wms_order_id = ${target.wmsOrderId} AND plan.plan_status = 'active'
  `));
  const plan = planRows[0];
  if (planRows.length > 1 || (plan && (Number(plan.oms_order_id) !== target.omsOrderId
    || (plan.line_id !== null && (Number(plan.wms_order_item_id) !== target.wmsOrderItemId
      || Number(plan.quantity_planned) > target.quantityPlanned))))) {
    throw new FulfillmentRequestAllocationError("CANONICAL_STATE_CONFLICT", "Request allocation plan does not match current order-line authority", {
      omsOrderLineId: target.omsOrderLineId, wmsOrderItemId: target.wmsOrderItemId,
    });
  }
  const fulfillmentPlanId = plan ? Number(plan.plan_id) : null;
  const fulfillmentPlanLineId = plan?.line_id != null ? Number(plan.line_id) : null;
  const requestRows = rows<{
    id: string; shipment_request_id: string; fulfillment_plan_id: string; line_plan_id: string;
    fulfillment_plan_line_id: string; wms_order_id: number; wms_order_item_id: number;
    oms_order_id: string; oms_order_line_id: string; warehouse_id: number | null;
    legacy_wms_shipment_item_id: number | null; quantity_requested: number; quantity_cancelled: number;
    request_status: FulfillmentRequestAllocationSnapshot["requestStatus"]; linked_to_shipping_order: boolean;
  }>(await tx.execute(sql`
    SELECT item.id, item.shipment_request_id, request.fulfillment_plan_id,
      line.fulfillment_plan_id AS line_plan_id, item.fulfillment_plan_line_id,
      request.wms_order_id, item.wms_order_item_id, plan.oms_order_id, line.oms_order_line_id,
      request.warehouse_id, item.legacy_wms_shipment_item_id,
      item.quantity_requested, item.quantity_cancelled, request.request_status,
      (EXISTS (SELECT 1 FROM wms.shipping_engine_order_requests AS link
        WHERE link.shipping_engine_order_id = ${shippingEngineOrderId}::bigint
          AND link.shipment_request_id = request.id)
       OR EXISTS (SELECT 1 FROM wms.shipping_engine_orders AS engine
        WHERE engine.id = ${shippingEngineOrderId}::bigint AND engine.shipment_request_id = request.id)) AS linked_to_shipping_order
    FROM wms.shipment_request_items AS item
    JOIN wms.shipment_requests AS request ON request.id = item.shipment_request_id
    JOIN wms.fulfillment_plan_lines AS line ON line.id = item.fulfillment_plan_line_id
    JOIN wms.fulfillment_plans AS plan ON plan.id = line.fulfillment_plan_id
    WHERE item.fulfillment_plan_line_id = ${fulfillmentPlanLineId}::bigint
      OR item.legacy_wms_shipment_item_id = ${target.legacyWmsShipmentItemId}
      OR item.id IN (SELECT physical.shipment_request_item_id FROM wms.physical_shipment_items AS physical
        WHERE physical.legacy_wms_shipment_item_id = ${target.legacyWmsShipmentItemId})
    ORDER BY item.id
    ${lockForUpdate ? sql`FOR UPDATE OF request, item` : sql``}
  `));
  if (requestRows.some(row => row.fulfillment_plan_id !== row.line_plan_id)) {
    throw new FulfillmentRequestAllocationError("CANONICAL_STATE_CONFLICT", "Request and line refer to different fulfillment plans", {
      omsOrderLineId: target.omsOrderLineId,
    });
  }
  const requests: FulfillmentRequestAllocationSnapshot[] = requestRows.map(row => ({
    shipmentRequestItemId: Number(row.id), shipmentRequestId: Number(row.shipment_request_id),
    fulfillmentPlanId: Number(row.fulfillment_plan_id), fulfillmentPlanLineId: Number(row.fulfillment_plan_line_id),
    wmsOrderId: Number(row.wms_order_id), wmsOrderItemId: Number(row.wms_order_item_id),
    omsOrderId: Number(row.oms_order_id), omsOrderLineId: Number(row.oms_order_line_id),
    warehouseId: row.warehouse_id == null ? null : Number(row.warehouse_id),
    legacyWmsShipmentItemId: row.legacy_wms_shipment_item_id == null ? null : Number(row.legacy_wms_shipment_item_id),
    quantityRequested: Number(row.quantity_requested), quantityCancelled: Number(row.quantity_cancelled),
    requestStatus: row.request_status, linkedToShippingOrder: row.linked_to_shipping_order,
  }));
  const physicalRows = rows<{
    shipment_request_item_id: string; fulfillment_plan_line_id: string; legacy_wms_shipment_item_id: number | null;
    provider: string; provider_physical_shipment_id: string; quantity_shipped: number; effective_quantity: number;
  }>(await tx.execute(sql`
    SELECT item.shipment_request_item_id, item.fulfillment_plan_line_id, item.legacy_wms_shipment_item_id,
      package.provider, package.provider_physical_shipment_id, item.quantity_shipped,
      item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) AS effective_quantity
    FROM wms.physical_shipment_items AS item
    JOIN wms.physical_shipments AS package ON package.id = item.physical_shipment_id
    LEFT JOIN wms.physical_shipment_item_quantity_adjustments AS adjustment ON adjustment.physical_shipment_item_id = item.id
    WHERE item.shipment_item_purpose = 'customer_fulfillment'
      AND (item.fulfillment_plan_line_id = ${fulfillmentPlanLineId}::bigint
        OR item.legacy_wms_shipment_item_id = ${target.legacyWmsShipmentItemId})
    ORDER BY item.id
  `));
  const physical: FulfillmentRequestPhysicalSnapshot[] = physicalRows.map(row => ({
    shipmentRequestItemId: Number(row.shipment_request_item_id), fulfillmentPlanLineId: Number(row.fulfillment_plan_line_id),
    legacyWmsShipmentItemId: row.legacy_wms_shipment_item_id == null ? null : Number(row.legacy_wms_shipment_item_id),
    shippingProvider: row.provider, providerPhysicalShipmentId: row.provider_physical_shipment_id,
    quantityShipped: Number(row.quantity_shipped), effectiveQuantityShipped: Number(row.effective_quantity),
  }));
  return resolveFulfillmentRequestAllocation({ ...target, fulfillmentPlanId, fulfillmentPlanLineId }, requests, physical);
}
