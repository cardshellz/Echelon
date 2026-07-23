import { sql } from "drizzle-orm";

import { FulfillmentAuthorityError } from "./channel-fulfillment-authority.repository";

export interface ChannelFulfillmentProjector {
  projectPhysicalShipment(physicalShipmentId: number): Promise<void>;
}

/**
 * Projects immutable physical-package allocations into the mutable OMS/WMS
 * read model. Physical package items, not provider callbacks or order-level
 * status guesses, are the sole quantity authority for this projection.
 */
export function createChannelFulfillmentProjector(db: any): ChannelFulfillmentProjector {
  async function projectPhysicalShipment(physicalShipmentId: number): Promise<void> {
    if (!Number.isInteger(physicalShipmentId) || physicalShipmentId <= 0) {
      throw new FulfillmentAuthorityError(
        "INVALID_INPUT",
        "physicalShipmentId must be a positive integer",
        { physicalShipmentId },
      );
    }
    if (typeof db?.transaction !== "function") {
      throw new FulfillmentAuthorityError(
        "INVALID_INPUT",
        "Canonical fulfillment projection requires transactional database support",
        { physicalShipmentId },
      );
    }

    await db.transaction(async (tx: any) => {
      const packageResult = await tx.execute(sql`
        SELECT id
        FROM wms.physical_shipments
        WHERE id = ${physicalShipmentId}
        FOR UPDATE
      `);
      if (!Array.isArray(packageResult?.rows) || packageResult.rows.length !== 1) {
        throw new FulfillmentAuthorityError(
          "PHYSICAL_SHIPMENT_NOT_FOUND",
          `Physical shipment ${physicalShipmentId} was not found for canonical projection`,
          { physicalShipmentId },
        );
      }

      await tx.execute(sql`
        WITH affected AS (
          SELECT DISTINCT item.wms_order_item_id
          FROM wms.physical_shipment_items item
          WHERE item.physical_shipment_id = ${physicalShipmentId}
            AND item.shipment_item_purpose = 'customer_fulfillment'
            AND item.wms_order_item_id IS NOT NULL
        ), shipped AS (
          SELECT item.wms_order_item_id,
                 SUM(item.quantity_shipped)::int AS shipped_quantity
          FROM wms.physical_shipment_items item
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
              GREATEST(order_item.picked_quantity, shipped.shipped_quantity)
            ),
            status = CASE
              WHEN shipped.shipped_quantity >= order_item.quantity THEN 'completed'
              WHEN shipped.shipped_quantity > 0 THEN 'in_progress'
              ELSE order_item.status
            END,
            picked_at = CASE
              WHEN shipped.shipped_quantity > 0 AND order_item.picked_at IS NULL THEN NOW()
              ELSE order_item.picked_at
            END
        FROM shipped
        WHERE order_item.id = shipped.wms_order_item_id
      `);

      await tx.execute(sql`
        WITH affected_orders AS (
          SELECT DISTINCT order_item.order_id
          FROM wms.physical_shipment_items physical_item
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

      await tx.execute(sql`
        WITH affected_lines AS (
          SELECT DISTINCT plan_line.oms_order_line_id
          FROM wms.physical_shipment_items physical_item
          JOIN wms.fulfillment_plan_lines plan_line
            ON plan_line.id = physical_item.fulfillment_plan_line_id
          WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
            AND physical_item.shipment_item_purpose = 'customer_fulfillment'
        ), shipped AS (
          SELECT
            plan_line.oms_order_line_id,
            SUM(physical_item.quantity_shipped)::int AS shipped_quantity
          FROM wms.physical_shipment_items physical_item
          JOIN wms.physical_shipments package ON package.id = physical_item.physical_shipment_id
          JOIN wms.fulfillment_plan_lines plan_line
            ON plan_line.id = physical_item.fulfillment_plan_line_id
          WHERE plan_line.oms_order_line_id IN (SELECT oms_order_line_id FROM affected_lines)
            AND physical_item.shipment_item_purpose = 'customer_fulfillment'
            AND package.status = 'shipped'
          GROUP BY plan_line.oms_order_line_id
        )
        UPDATE oms.oms_order_lines oms_line
        SET fulfillment_status = CASE
              WHEN COALESCE(oms_line.authority_fulfillable_quantity, 0) <= 0 THEN oms_line.fulfillment_status
              WHEN shipped.shipped_quantity >= oms_line.authority_fulfillable_quantity THEN 'fulfilled'
              WHEN shipped.shipped_quantity > 0 THEN 'partial'
              ELSE 'unfulfilled'
            END,
            updated_at = NOW()
        FROM shipped
        WHERE oms_line.id = shipped.oms_order_line_id
      `);

      await tx.execute(sql`
        WITH affected_orders AS (
          SELECT DISTINCT oms_line.order_id
          FROM wms.physical_shipment_items physical_item
          JOIN wms.fulfillment_plan_lines plan_line
            ON plan_line.id = physical_item.fulfillment_plan_line_id
          JOIN oms.oms_order_lines oms_line ON oms_line.id = plan_line.oms_order_line_id
          WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
            AND physical_item.shipment_item_purpose = 'customer_fulfillment'
        ), line_rollup AS (
          SELECT
            oms_line.order_id,
            COUNT(*) FILTER (
              WHERE oms_line.requires_shipping = true
                AND COALESCE(oms_line.authority_fulfillable_quantity, 0) > 0
            )::int AS required_lines,
            COUNT(*) FILTER (
              WHERE oms_line.requires_shipping = true
                AND COALESCE(oms_line.authority_fulfillable_quantity, 0) > 0
                AND oms_line.fulfillment_status = 'fulfilled'
            )::int AS fulfilled_lines,
            COUNT(*) FILTER (
              WHERE oms_line.requires_shipping = true
                AND oms_line.fulfillment_status IN ('partial', 'fulfilled')
            )::int AS touched_lines
          FROM oms.oms_order_lines oms_line
          WHERE oms_line.order_id IN (SELECT order_id FROM affected_orders)
          GROUP BY oms_line.order_id
        ), latest_tracking AS (
          SELECT DISTINCT ON (oms_line.order_id)
            oms_line.order_id,
            COALESCE(amendment.tracking_number, package.tracking_number) AS tracking_number,
            COALESCE(amendment.carrier, package.carrier) AS carrier,
            COALESCE(amendment.occurred_at, package.ship_date, package.created_at) AS shipped_at
          FROM wms.physical_shipment_items physical_item
          JOIN wms.physical_shipments package ON package.id = physical_item.physical_shipment_id
          JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id = physical_item.fulfillment_plan_line_id
          JOIN oms.oms_order_lines oms_line ON oms_line.id = plan_line.oms_order_line_id
          LEFT JOIN LATERAL (
            SELECT tracking_number, carrier, occurred_at
            FROM wms.physical_shipment_tracking_amendments
            WHERE physical_shipment_id = package.id
            ORDER BY occurred_at DESC, id DESC
            LIMIT 1
          ) amendment ON TRUE
          WHERE oms_line.order_id IN (SELECT order_id FROM affected_orders)
            AND package.status = 'shipped'
          ORDER BY oms_line.order_id,
                   COALESCE(amendment.occurred_at, package.ship_date, package.created_at) DESC,
                   package.id DESC
        )
        UPDATE oms.oms_orders oms_order
        SET fulfillment_status = CASE
              WHEN rollup.required_lines > 0 AND rollup.fulfilled_lines = rollup.required_lines THEN 'fulfilled'
              WHEN rollup.touched_lines > 0 THEN 'partial'
              ELSE 'unfulfilled'
            END,
            status = CASE
              WHEN oms_order.status IN ('cancelled', 'refunded')
                OR oms_order.financial_status IN ('refunded', 'voided')
                THEN oms_order.status
              WHEN rollup.required_lines > 0 AND rollup.fulfilled_lines = rollup.required_lines THEN 'shipped'
              ELSE oms_order.status
            END,
            tracking_number = tracking.tracking_number,
            tracking_carrier = tracking.carrier,
            shipped_at = tracking.shipped_at,
            updated_at = NOW()
        FROM line_rollup rollup
        LEFT JOIN latest_tracking tracking ON tracking.order_id = rollup.order_id
        WHERE oms_order.id = rollup.order_id
      `);
    });
  }

  return Object.freeze({ projectPhysicalShipment });
}
