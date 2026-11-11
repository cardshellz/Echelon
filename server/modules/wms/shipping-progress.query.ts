import { sql } from "drizzle-orm";
import { WmsShippingProgressError, type WmsShippingProgressLine } from "@shared/wms-shipping-progress";

export interface WmsShippingProgressRow {
  order_id: number;
  warehouse_status: string;
  id: number;
  quantity: number;
  picked_quantity: number;
  requires_shipping: number;
  status: string;
  authority_fulfillable_quantity: number | null;
  shipped_quantity: string | number;
}

/**
 * The one definition of "customer units shipped" for a WMS order item.
 *
 * Yields one `quantity` row per piece of shipment evidence for the order item
 * aliased `oi` in the enclosing query (`oi.id`, `oi.order_id`). Every reader
 * that needs shipped units must sum these rows rather than restate the rule.
 *
 * Canonical package portions replace their compatibility source item, not add
 * to it. Even voided/adjusted-to-zero canonical items suppress that fallback.
 * This keeps a label for one of three units from inheriting a whole-request qty.
 */
const SHIPPED_UNITS_EVIDENCE_SQL = sql`
        SELECT physical.quantity_shipped AS quantity
        FROM wms.effective_physical_shipment_items physical
        JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id = physical.fulfillment_plan_line_id
        JOIN wms.physical_shipments package ON package.id = physical.physical_shipment_id
        JOIN wms.shipment_request_items request_item ON request_item.id = physical.shipment_request_item_id
        JOIN wms.shipment_requests request ON request.id = request_item.shipment_request_id
        LEFT JOIN wms.outbound_shipment_items source_item
          ON source_item.id = COALESCE(physical.legacy_wms_shipment_item_id, request_item.legacy_wms_shipment_item_id)
        LEFT JOIN wms.outbound_shipments source_shipment ON source_shipment.id = source_item.shipment_id
        WHERE physical.wms_order_item_id = oi.id
          AND plan_line.wms_order_item_id = oi.id
          AND request.wms_order_id = oi.order_id
          AND physical.shipment_item_purpose = 'customer_fulfillment'
          AND package.status IN ('shipped', 'returned')
          AND COALESCE(source_shipment.source, '') NOT LIKE '%_fulfillment_receipt'
        UNION ALL
        SELECT item.qty AS quantity
        FROM wms.outbound_shipment_items item
        JOIN wms.outbound_shipments shipment ON shipment.id = item.shipment_id
        WHERE item.order_item_id = oi.id
          AND shipment.order_id = oi.order_id
          AND item.shipment_item_purpose = 'customer_fulfillment'
          AND COALESCE(shipment.shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'
          AND shipment.status IN ('shipped', 'returned', 'lost')
          AND COALESCE(shipment.source, '') NOT LIKE '%_fulfillment_receipt'
          AND NOT EXISTS (
            SELECT 1 FROM wms.physical_shipment_items physical
            JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id = physical.fulfillment_plan_line_id
            JOIN wms.shipment_request_items request_item ON request_item.id = physical.shipment_request_item_id
            WHERE physical.wms_order_item_id = oi.id
              AND plan_line.wms_order_item_id = oi.id
              AND (physical.legacy_wms_shipment_item_id = item.id
                OR request_item.legacy_wms_shipment_item_id = item.id)
          )`;

function positiveIds(ids: readonly number[], message: string): readonly number[] {
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new WmsShippingProgressError(message);
  }
  return ids;
}

/** Scoped to affected orders; never scans the full shipping ledger for a page. */
export function wmsShippingProgressQuery(orderIds: readonly number[]) {
  positiveIds(orderIds, "Shipping progress requires positive order IDs");
  return sql`
    SELECT wms_order.id AS order_id, wms_order.warehouse_status,
           oi.id, oi.quantity, oi.picked_quantity, oi.requires_shipping, oi.status,
           ol.authority_fulfillable_quantity,
           COALESCE(coverage.shipped_quantity, 0) AS shipped_quantity
    FROM wms.orders wms_order
    JOIN wms.order_items oi ON oi.order_id = wms_order.id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
    LEFT JOIN LATERAL (
      SELECT SUM(evidence.quantity)::bigint AS shipped_quantity
      FROM (${SHIPPED_UNITS_EVIDENCE_SQL}
      ) evidence
    ) coverage ON TRUE
    WHERE wms_order.id IN (${sql.join(orderIds.map(id => sql`${id}`), sql`, `)})
    ORDER BY wms_order.id, oi.id
    FOR UPDATE OF wms_order
  `;
}

export function shippingProgressLine(row: WmsShippingProgressRow): WmsShippingProgressLine {
  if (row.requires_shipping !== 0 && row.requires_shipping !== 1) {
    throw new WmsShippingProgressError("Invalid shipping requirement for WMS order item", { wmsOrderItemId: row.id });
  }
  return {
    id: Number(row.id), quantity: Number(row.quantity), pickedQuantity: Number(row.picked_quantity),
    shippedQuantity: Number(row.shipped_quantity), requiresShipping: row.requires_shipping === 1,
    cancelled: row.status === "cancelled",
    authorizedQuantity: row.authority_fulfillable_quantity == null ? null : Number(row.authority_fulfillable_quantity),
  };
}

export interface ShippedUnitsByOrderLineRow {
  oms_order_id: string | number;
  oms_order_line_id: string | number;
  shipped_quantity: string | number;
}

export interface ShippedUnitsByOrderLine {
  omsOrderId: number;
  omsOrderLineId: number;
  shippedQuantity: number;
}

/**
 * Read-only answer to "how many customer units of each purchased line have
 * shipped?" for whole orders. Takes no locks, so it is safe on read paths.
 *
 * Every line of each requested order is returned; a line with no shipment
 * evidence (never sent to the warehouse, not yet shipped, or removed) reports
 * zero. Uses the same evidence definition as the locking progress query above.
 */
export function shippedUnitsByOrderLineQuery(omsOrderIds: readonly number[]) {
  positiveIds(omsOrderIds, "Shipped units require positive order IDs");
  return sql`
    SELECT ol.order_id AS oms_order_id, ol.id AS oms_order_line_id,
           COALESCE(SUM(coverage.shipped_quantity), 0)::bigint AS shipped_quantity
    FROM oms.oms_order_lines ol
    LEFT JOIN wms.order_items oi ON oi.oms_order_line_id = ol.id
    LEFT JOIN LATERAL (
      SELECT SUM(evidence.quantity)::bigint AS shipped_quantity
      FROM (${SHIPPED_UNITS_EVIDENCE_SQL}
      ) evidence
    ) coverage ON TRUE
    WHERE ol.order_id IN (${sql.join(omsOrderIds.map(id => sql`${id}`), sql`, `)})
    GROUP BY ol.order_id, ol.id
    ORDER BY ol.order_id, ol.id
  `;
}

export function shippedUnitsByOrderLine(row: ShippedUnitsByOrderLineRow): ShippedUnitsByOrderLine {
  const line = {
    omsOrderId: Number(row.oms_order_id),
    omsOrderLineId: Number(row.oms_order_line_id),
    shippedQuantity: Number(row.shipped_quantity),
  };
  if (!Number.isSafeInteger(line.omsOrderId) || line.omsOrderId <= 0
    || !Number.isSafeInteger(line.omsOrderLineId) || line.omsOrderLineId <= 0
    || !Number.isSafeInteger(line.shippedQuantity) || line.shippedQuantity < 0) {
    throw new WmsShippingProgressError("Invalid shipped units for order line", { omsOrderLineId: line.omsOrderLineId });
  }
  return line;
}
