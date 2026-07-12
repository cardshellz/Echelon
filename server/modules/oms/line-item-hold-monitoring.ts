import { sql } from "drizzle-orm";

// A held pre-order line older than this needs operator review. The threshold is
// shared by the legacy health summary and the Control Tower waterfall so the
// two monitoring surfaces cannot drift.
export const HELD_LINE_AGING_DAYS = 30;

function boundedSampleLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error("line-item hold sample limit must be an integer between 1 and 500");
  }
  return value;
}

export function heldLineAgingCountQuery() {
  return sql`
    SELECT COUNT(*)::int AS count
    FROM wms.outbound_shipments os
    WHERE os.held = true
      AND os.source = 'line_item_hold'
      AND os.status NOT IN ('shipped', 'cancelled', 'voided')
      AND os.held_at IS NOT NULL
      AND os.held_at < NOW() - (${HELD_LINE_AGING_DAYS} * INTERVAL '1 day')
  `;
}

export function heldLineAgingSampleQuery(limit: number) {
  const sampleLimit = boundedSampleLimit(limit);
  return sql`
    SELECT os.id AS shipment_id, os.order_id AS wms_order_id, wo.order_number,
           oi.sku, oi.quantity, os.on_hold_reason AS hold_reason,
           os.held_at, (NOW()::date - os.held_at::date) AS days_held
    FROM wms.outbound_shipments os
    JOIN wms.orders wo ON wo.id = os.order_id
    LEFT JOIN wms.outbound_shipment_items osi ON osi.shipment_id = os.id
    LEFT JOIN wms.order_items oi ON oi.id = osi.order_item_id
    WHERE os.held = true
      AND os.source = 'line_item_hold'
      AND os.status NOT IN ('shipped', 'cancelled', 'voided')
      AND os.held_at IS NOT NULL
      AND os.held_at < NOW() - (${HELD_LINE_AGING_DAYS} * INTERVAL '1 day')
    ORDER BY os.held_at ASC
    LIMIT ${sampleLimit}
  `;
}

export function allLinesHeldCountQuery() {
  return sql`
    SELECT COUNT(*)::int AS count FROM (
      SELECT wo.id
      FROM wms.orders wo
      JOIN wms.order_items oi ON oi.order_id = wo.id
      WHERE wo.warehouse_status NOT IN ('cancelled', 'shipped')
      GROUP BY wo.id
      HAVING BOOL_OR(COALESCE(oi.on_hold, false)) = true
         AND SUM(COALESCE(oi.fulfilled_quantity, 0)) = 0
         AND COUNT(*) FILTER (
               WHERE COALESCE(oi.requires_shipping, 1) <> 0
                 AND oi.status NOT IN ('cancelled', 'completed')
                 AND COALESCE(oi.on_hold, false) = false
             ) = 0
    ) held_orders
  `;
}

export function allLinesHeldSampleQuery(limit: number) {
  const sampleLimit = boundedSampleLimit(limit);
  return sql`
    SELECT wo.id AS wms_order_id, wo.order_number, wo.warehouse_status,
           COUNT(*) FILTER (WHERE COALESCE(oi.on_hold, false) = true)::int AS held_lines,
           (SELECT MIN(os.held_at)
              FROM wms.outbound_shipments os
              WHERE os.order_id = wo.id
                AND os.source = 'line_item_hold'
                AND os.held = true) AS held_since
    FROM wms.orders wo
    JOIN wms.order_items oi ON oi.order_id = wo.id
    WHERE wo.warehouse_status NOT IN ('cancelled', 'shipped')
    GROUP BY wo.id, wo.order_number, wo.warehouse_status
    HAVING BOOL_OR(COALESCE(oi.on_hold, false)) = true
       AND SUM(COALESCE(oi.fulfilled_quantity, 0)) = 0
       AND COUNT(*) FILTER (
             WHERE COALESCE(oi.requires_shipping, 1) <> 0
               AND oi.status NOT IN ('cancelled', 'completed')
               AND COALESCE(oi.on_hold, false) = false
           ) = 0
    ORDER BY held_since ASC NULLS LAST
    LIMIT ${sampleLimit}
  `;
}
