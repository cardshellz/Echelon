import type { PoolClient } from "pg";
import { z } from "zod";
import {
  wmsCutoverDemandCaptureSchema, wmsCutoverDemandOrderSchema, wmsCutoverDemandItemSchema,
  wmsCutoverSourceItemSchema, wmsCutoverPhysicalItemSchema,
  type WmsCutoverDemandCapture,
} from "@shared/types/inventory-cutover-demand";

export interface WmsCutoverCaptureLimits {
  orders: number; items: number; sourceItems: number; physicalItems: number;
}
export const WMS_CUTOVER_CAPTURE_LIMITS: Readonly<WmsCutoverCaptureLimits> = Object.freeze({
  orders: 10_000, items: 50_000, sourceItems: 100_000, physicalItems: 100_000,
});
type QueryClient = Pick<PoolClient, "query">;

export class WmsCutoverDemandCaptureError extends Error {
  readonly classification = "permanent";
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "WmsCutoverDemandCaptureError";
  }
}

function parseRows<T>(schema: z.ZodType<T>, rows: unknown[], limit: number, kind: string): T[] {
  if (rows.length > limit) throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_LIMIT_EXCEEDED",
    "Nonterminal WMS demand capture exceeds its evidence bound; no partial snapshot is usable", { kind, limit });
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_EVIDENCE_INVALID",
    "WMS demand evidence cannot be represented by the raw capture contract", { kind, issues: parsed.error.issues });
  return parsed.data;
}

function validateLimits(input: Partial<WmsCutoverCaptureLimits>): WmsCutoverCaptureLimits {
  if (Object.keys(input).some((key) => !Object.prototype.hasOwnProperty.call(WMS_CUTOVER_CAPTURE_LIMITS, key))) {
    throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_LIMIT_INVALID", "Unknown WMS capture limit");
  }
  const limits = { ...WMS_CUTOVER_CAPTURE_LIMITS, ...input };
  for (const kind of Object.keys(WMS_CUTOVER_CAPTURE_LIMITS) as Array<keyof WmsCutoverCaptureLimits>) {
    if (!Number.isSafeInteger(limits[kind]) || limits[kind] < 1 || limits[kind] > WMS_CUTOVER_CAPTURE_LIMITS[kind]) {
      throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_LIMIT_INVALID", "Capture limits must be positive and within supported bounds", { kind, value: limits[kind] });
    }
  }
  return limits;
}

/**
 * WMS-owned raw evidence on the caller's repeatable-read READ ONLY snapshot.
 * No transaction creation, locks, inventory/OMS queries, or demand inference.
 * Terminal-order custody and unattributed package rows require separate global
 * preflight evidence; this deliberately bounded scope cannot certify activation.
 */
export async function readWmsCutoverDemand(
  client: QueryClient,
  requestedLimits: Partial<WmsCutoverCaptureLimits> = {},
): Promise<WmsCutoverDemandCapture> {
  const limits = validateLimits(requestedLimits);
  const metadata = await client.query(`SELECT transaction_timestamp() AS "capturedAt",
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS "readOnly",
    (SELECT count(*)::text FROM wms.orders WHERE warehouse_status IN ('shipped','cancelled')) AS "excludedTerminalOrderCount"`);
  const meta = metadata.rows[0];
  if (!meta || !["repeatable read", "serializable"].includes(meta.isolation) || meta.readOnly !== "on") {
    throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_SNAPSHOT_REQUIRED", "WMS demand capture requires the caller's repeatable-read READ ONLY transaction");
  }
  if (meta.capturedAt instanceof Date && Number.isNaN(meta.capturedAt.getTime())) {
    throw new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_EVIDENCE_INVALID", "Snapshot timestamp is invalid");
  }
  const capturedAt = meta.capturedAt instanceof Date ? meta.capturedAt.toISOString() : meta.capturedAt;
  const orderRows = await client.query(`SELECT id, warehouse_id AS "warehouseId", warehouse_status AS status,
    on_hold AS "onHold", channel_id AS "channelId", source, external_order_id AS "externalOrderId",
    oms_fulfillment_order_id AS "omsFulfillmentOrderId", fulfillment_partition_key AS "fulfillmentPartitionKey"
    FROM wms.orders WHERE warehouse_status IS NULL OR warehouse_status NOT IN ('shipped','cancelled')
    ORDER BY id LIMIT $1`, [limits.orders + 1]);
  const orders = parseRows(wmsCutoverDemandOrderSchema, orderRows.rows, limits.orders, "orders");
  const orderIds = orders.map((order) => order.id);
  if (!orderIds.length) return wmsCutoverDemandCaptureSchema.parse({
    schemaVersion: "wms_inventory_cutover_demand_v1", scope: "nonterminal_wms_orders", capturedAt,
    excludedTerminalOrderCount: meta.excludedTerminalOrderCount, orders, items: [], sourceItems: [], physicalItems: [],
  });
  const itemRows = await client.query(`SELECT id, order_id AS "orderId", oms_order_line_id::text AS "omsOrderLineId",
    source_item_id AS "sourceItemId", sku, product_id AS "productId", quantity,
    picked_quantity AS "pickedQuantity", fulfilled_quantity AS "fulfilledQuantity", status,
    on_hold AS "onHold", requires_shipping AS "requiresShipping", location, short_reason AS "shortReason"
    FROM wms.order_items WHERE order_id=ANY($1::integer[]) ORDER BY order_id,id LIMIT $2`, [orderIds, limits.items + 1]);
  const items = parseRows(wmsCutoverDemandItemSchema, itemRows.rows, limits.items, "items");
  const itemIds = items.map((item) => item.id);
  // Include foreign/missing header membership for selected items as evidence,
  // rather than dropping it through an inner join that would hide corruption.
  const sourceRows = await client.query(`SELECT source.id, source.shipment_id AS "shipmentId", shipment.order_id AS "headerOrderId",
    source.order_item_id AS "orderItemId", source.replacement_for_order_item_id AS "replacementForOrderItemId",
    source.correction_for_shipment_item_id AS "correctionForShipmentItemId", source.product_variant_id AS "productVariantId",
    source.qty AS quantity, source.shipment_item_purpose AS purpose, source.from_location_id AS "fromLocationId",
    shipment.status AS "shipmentStatus", shipment.held AS "shipmentHeld"
    FROM wms.outbound_shipment_items source LEFT JOIN wms.outbound_shipments shipment ON shipment.id=source.shipment_id
    WHERE shipment.order_id=ANY($1::integer[]) OR source.order_item_id=ANY($2::integer[])
      OR source.replacement_for_order_item_id=ANY($2::integer[])
    ORDER BY source.id LIMIT $3`, [orderIds, itemIds, limits.sourceItems + 1]);
  const sourceItems = parseRows(wmsCutoverSourceItemSchema, sourceRows.rows, limits.sourceItems, "sourceItems");
  // Do NOT use effective_physical_shipment_items: its positive-only filter hides
  // fully adjusted rows. Preserve original/delta/effective facts separately.
  const physicalRows = await client.query(`SELECT item.id::text AS id, item.physical_shipment_id::text AS "physicalShipmentId",
    item.wms_order_item_id AS "orderItemId", item.replacement_for_order_item_id AS "replacementForOrderItemId",
    item.legacy_wms_shipment_item_id AS "legacySourceShipmentItemId", item.package_allocation_entry_id::text AS "packageAllocationEntryId",
    item.product_variant_id AS "productVariantId", item.sku, item.quantity_shipped AS "originalQuantity",
    COALESCE(adjustment.quantity_delta,0) AS "adjustmentQuantity",
    (item.quantity_shipped::bigint+COALESCE(adjustment.quantity_delta,0))::text AS "effectiveQuantity",
    item.shipment_item_purpose AS purpose, package.status AS "packageStatus"
    FROM wms.physical_shipment_items item LEFT JOIN wms.physical_shipments package ON package.id=item.physical_shipment_id
    LEFT JOIN wms.physical_shipment_item_quantity_adjustments adjustment ON adjustment.physical_shipment_item_id=item.id
    WHERE item.wms_order_item_id=ANY($1::integer[]) OR item.replacement_for_order_item_id=ANY($1::integer[])
      OR item.legacy_wms_shipment_item_id=ANY($2::integer[])
    ORDER BY item.id LIMIT $3`, [itemIds, sourceItems.map((source) => source.id), limits.physicalItems + 1]);
  const physicalItems = parseRows(wmsCutoverPhysicalItemSchema, physicalRows.rows, limits.physicalItems, "physicalItems");
  return wmsCutoverDemandCaptureSchema.parse({ schemaVersion: "wms_inventory_cutover_demand_v1",
    scope: "nonterminal_wms_orders", capturedAt, excludedTerminalOrderCount: meta.excludedTerminalOrderCount,
    orders, items, sourceItems, physicalItems });
}
