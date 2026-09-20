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

/** Scoped to affected orders; never scans the full shipping ledger for a page.
 * Canonical package portions replace their compatibility source item, not add
 * to it. Even voided/adjusted-to-zero canonical items suppress that fallback.
 * This keeps a label for one of three units from inheriting a whole-request qty.
 */
export function wmsShippingProgressQuery(orderIds: readonly number[]) {
  if (!orderIds.length || orderIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new WmsShippingProgressError("Shipping progress requires positive order IDs");
  }
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
      FROM (
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
          )
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
