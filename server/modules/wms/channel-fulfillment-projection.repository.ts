import { sql } from "drizzle-orm";
import { deriveWmsShippingProgress, type WmsShippingProgressLine } from "@shared/wms-shipping-progress";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import { shippingProgressLine, wmsShippingProgressQuery, type WmsShippingProgressRow } from "./shipping-progress.query";

export class WmsFulfillmentProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WmsFulfillmentProjectionError";
  }
}

/**
 * Project one immutable physical package into WMS-owned mutable read models.
 *
 * The caller supplies the transaction so the WMS and OMS projections can
 * commit atomically without either module writing the other module's tables.
 */
export async function projectPhysicalShipmentToWms(
  transaction: any,
  physicalShipmentId: number,
): Promise<void> {
  if (!Number.isInteger(physicalShipmentId) || physicalShipmentId <= 0) {
    throw new WmsFulfillmentProjectionError(
      "INVALID_INPUT",
      "physicalShipmentId must be a positive integer",
      { physicalShipmentId },
    );
  }
  if (typeof transaction?.execute !== "function") {
    throw new WmsFulfillmentProjectionError(
      "INVALID_INPUT",
      "WMS fulfillment projection requires a database transaction",
      { physicalShipmentId },
    );
  }

  const packageResult = await transaction.execute(sql`
    SELECT id
    FROM wms.physical_shipments
    WHERE id = ${physicalShipmentId}
    FOR UPDATE
  `);
  if (!Array.isArray(packageResult?.rows) || packageResult.rows.length !== 1) {
    throw new WmsFulfillmentProjectionError(
      "PHYSICAL_SHIPMENT_NOT_FOUND",
      `Physical shipment ${physicalShipmentId} was not found for canonical projection`,
      { physicalShipmentId },
    );
  }

  // Acquire each affected order before reading quantity coverage. A lock taken
  // in the coverage SELECT itself can wait on another projector while retaining
  // its pre-wait snapshot, then overwrite that projector's completed status.
  const affected = await transaction.execute(sql`
    SELECT orders.id AS order_id
    FROM wms.orders orders
    WHERE orders.id IN (
      SELECT order_item.order_id
      FROM wms.physical_shipment_items physical_item
      JOIN wms.order_items order_item ON order_item.id = physical_item.wms_order_item_id
      WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
        AND physical_item.shipment_item_purpose = 'customer_fulfillment'
    )
    ORDER BY orders.id
    FOR UPDATE OF orders
  `);
  const orderIds = affected.rows.map((row: { order_id: number }) => Number(row.order_id));

  await transaction.execute(sql`
    WITH affected AS (
      SELECT DISTINCT item.wms_order_item_id
      FROM wms.physical_shipment_items item
      WHERE item.physical_shipment_id = ${physicalShipmentId}
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND item.wms_order_item_id IS NOT NULL
    ), shipped_quantities AS (
      SELECT item.wms_order_item_id,
             SUM(item.quantity_shipped)::int AS shipped_quantity
      FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
      JOIN wms.shipment_request_items request_item ON request_item.id = item.shipment_request_item_id
      LEFT JOIN wms.outbound_shipment_items legacy_item
        ON legacy_item.id = COALESCE(item.legacy_wms_shipment_item_id, request_item.legacy_wms_shipment_item_id)
      LEFT JOIN wms.outbound_shipments legacy_shipment ON legacy_shipment.id = legacy_item.shipment_id
      WHERE item.wms_order_item_id IN (SELECT wms_order_item_id FROM affected)
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND package.status IN ('shipped', 'returned')
        AND COALESCE(legacy_shipment.source, '') NOT LIKE '%_fulfillment_receipt'
      GROUP BY item.wms_order_item_id
    ), shipped AS (
      SELECT affected.wms_order_item_id, COALESCE(shipped_quantities.shipped_quantity, 0) AS shipped_quantity
      FROM affected
      LEFT JOIN shipped_quantities USING (wms_order_item_id)
    )
    UPDATE wms.order_items order_item
    SET fulfilled_quantity = LEAST(order_item.quantity, shipped.shipped_quantity),
        picked_quantity = LEAST(
          order_item.quantity,
          GREATEST(
            COALESCE(order_item.picked_quantity, 0),
            COALESCE(shipped.shipped_quantity, 0)
          )
        ),
        status = CASE
          WHEN GREATEST(
            COALESCE(order_item.picked_quantity, 0),
            COALESCE(shipped.shipped_quantity, 0)
          ) >= order_item.quantity THEN 'completed'
          WHEN GREATEST(
            COALESCE(order_item.picked_quantity, 0),
            COALESCE(shipped.shipped_quantity, 0)
          ) > 0 THEN 'in_progress'
          ELSE order_item.status
        END,
        picked_at = CASE
          WHEN shipped.shipped_quantity > 0 AND order_item.picked_at IS NULL THEN NOW()
          ELSE order_item.picked_at
        END
    FROM shipped
    WHERE order_item.id = shipped.wms_order_item_id
      AND order_item.requires_shipping = 1
      AND order_item.status <> 'cancelled'
  `);

  if (orderIds.length === 0) return;
  const result = await transaction.execute(wmsShippingProgressQuery(orderIds));
  const orders = new Map<number, { status: WmsWarehouseStatus; lines: WmsShippingProgressLine[] }>();
  for (const row of result.rows as WmsShippingProgressRow[]) {
    const orderId = Number(row.order_id);
    const order: { status: WmsWarehouseStatus; lines: WmsShippingProgressLine[] } =
      orders.get(orderId) ?? { status: row.warehouse_status as WmsWarehouseStatus, lines: [] };
    order.lines.push(shippingProgressLine(row));
    orders.set(orderId, order);
  }
  for (const [orderId, order] of orders) {
    const status = deriveWmsShippingProgress(order.status, order.lines);
    const pickedCount = order.lines.filter(line => line.requiresShipping)
      .reduce((sum, line) => sum + line.pickedQuantity, 0);
    await transaction.execute(sql`
      UPDATE wms.orders
      SET picked_count = ${pickedCount}, warehouse_status = ${status}, updated_at = NOW()
      WHERE id = ${orderId}
    `);
  }
}
