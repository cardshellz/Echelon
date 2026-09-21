import { sql } from "drizzle-orm";

/**
 * Guard for WMS "self-heal" paths that move an order with no pending lines to
 * a terminal status (startup zombie repair, pick-queue auto-complete).
 *
 * OMS owns the order lifecycle (BOUNDARIES.md). A WMS order with no pending
 * lines is only finished if the OMS agrees nothing more is owed. When the
 * linked OMS order is still live and a shippable line's authority exceeds the
 * non-cancelled quantity materialized for it, the WMS lines were lost — e.g.
 * the 2026-09-18 Shopify fulfillment-hold defect that cancelled order #63275's
 * only line — and a terminal transition would silently drop a paid shipment.
 *
 * Materialized quantity is summed across ALL WMS orders for the line, because
 * a line can be split across partitions; one order's rows alone would
 * under-count and block legitimate completion. OMS finality matches
 * shipstation-sweeper `isOmsOrderFinal`.
 *
 * Alias contract: the enclosing query must alias wms.orders as `o`.
 */
export const LIVE_OMS_DEMAND_NOT_CARRIED_BY_WMS_ORDER_O = sql`
  EXISTS (
    SELECT 1
    FROM oms.oms_orders oo
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    WHERE o.oms_fulfillment_order_id ~ '^[1-9][0-9]{0,17}$'
      AND oo.id = o.oms_fulfillment_order_id::bigint
      AND oo.status NOT IN ('cancelled', 'shipped', 'refunded')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(ol.requires_shipping, true)
      AND COALESCE(ol.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(ol.authority_fulfillable_quantity, 0) > COALESCE((
        SELECT SUM(wi.quantity)
        FROM wms.order_items wi
        WHERE wi.oms_order_line_id = ol.id
          AND wi.status <> 'cancelled'
      ), 0)
  )
`;

interface GuardDb {
  execute(query: unknown): Promise<{ rows?: unknown[] }>;
}

export async function hasLiveOmsDemandNotCarriedByWms(
  database: GuardDb,
  wmsOrderId: number,
): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT ${LIVE_OMS_DEMAND_NOT_CARRIED_BY_WMS_ORDER_O} AS owes
    FROM wms.orders o
    WHERE o.id = ${wmsOrderId}
  `);
  const row = (result.rows ?? [])[0] as { owes?: unknown } | undefined;
  return row?.owes === true;
}
