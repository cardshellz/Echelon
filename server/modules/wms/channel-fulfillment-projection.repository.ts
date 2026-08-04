import { sql } from "drizzle-orm";

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

  await transaction.execute(sql`
    WITH affected AS (
      SELECT DISTINCT item.wms_order_item_id
      FROM wms.effective_physical_shipment_items item
      WHERE item.physical_shipment_id = ${physicalShipmentId}
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND item.wms_order_item_id IS NOT NULL
    ), shipped AS (
      SELECT item.wms_order_item_id,
             SUM(item.quantity_shipped)::int AS shipped_quantity
      FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
      WHERE item.wms_order_item_id IN (SELECT wms_order_item_id FROM affected)
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND package.status = 'shipped'
      GROUP BY item.wms_order_item_id
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
  `);

  await transaction.execute(sql`
    WITH affected_orders AS (
      SELECT DISTINCT order_item.order_id
      FROM wms.effective_physical_shipment_items physical_item
      JOIN wms.order_items order_item ON order_item.id = physical_item.wms_order_item_id
      WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
        AND physical_item.shipment_item_purpose = 'customer_fulfillment'
    ), rollup AS (
      SELECT
        order_item.order_id,
        SUM(order_item.quantity) FILTER (WHERE order_item.requires_shipping = 1)::int AS required_quantity,
        SUM(order_item.picked_quantity) FILTER (WHERE order_item.requires_shipping = 1)::int AS picked_quantity,
        SUM(order_item.fulfilled_quantity) FILTER (WHERE order_item.requires_shipping = 1)::int AS fulfilled_quantity
      FROM wms.order_items order_item
      WHERE order_item.order_id IN (SELECT order_id FROM affected_orders)
      GROUP BY order_item.order_id
    )
    UPDATE wms.orders wms_order
    SET picked_count = COALESCE(rollup.picked_quantity, 0),
        warehouse_status = CASE
          WHEN COALESCE(rollup.required_quantity, 0) > 0
           AND COALESCE(rollup.fulfilled_quantity, 0) >= rollup.required_quantity THEN 'shipped'
          WHEN COALESCE(rollup.fulfilled_quantity, 0) > 0 THEN 'partially_shipped'
          ELSE wms_order.warehouse_status
        END,
        updated_at = NOW()
    FROM rollup
    WHERE wms_order.id = rollup.order_id
      AND wms_order.warehouse_status <> 'cancelled'
  `);
}
