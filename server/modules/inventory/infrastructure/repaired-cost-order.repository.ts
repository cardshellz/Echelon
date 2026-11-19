import { sql } from "drizzle-orm";
import {
  costInteger,
  CostEvidenceError,
  type CostEvidenceTransaction,
} from "./cost-evidence.repository";

const MAX_ORDER_EVIDENCE_ROWS = 100_000;
function bounded<T>(rows: T[]): T[] {
  if (rows.length > MAX_ORDER_EVIDENCE_ROWS)
    throw new CostEvidenceError(
      "COST_ORDER_REVIEW_LIMIT",
      "The complete recorded order history exceeds the cost review limit.",
    );
  return rows;
}

export async function readRepairedOrderEvidence(
  tx: CostEvidenceTransaction,
  lotIds: number[],
) {
  const costs = bounded(
    (
      await tx.execute(sql`SELECT id,inventory_lot_id,order_id,order_item_id,qty
    FROM oms.order_item_costs WHERE inventory_lot_id=ANY(${sql.param(lotIds)}::int[])
    ORDER BY id LIMIT ${MAX_ORDER_EVIDENCE_ROWS + 1} FOR UPDATE`)
    ).rows,
  );
  const orderIds = [
    ...new Set(costs.map((row) => costInteger(row.order_id, "order", 1))),
  ];
  const itemIds = [
    ...new Set(
      costs.map((row) => costInteger(row.order_item_id, "order item", 1)),
    ),
  ];
  const orders = bounded(
    (
      await tx.execute(sql`SELECT id,warehouse_status,cancelled_at FROM wms.orders
    WHERE id=ANY(${sql.param(orderIds)}::int[]) ORDER BY id LIMIT ${MAX_ORDER_EVIDENCE_ROWS + 1} FOR SHARE`)
    ).rows,
  );
  const items = bounded(
    (
      await tx.execute(sql`SELECT id,order_id,quantity,status FROM wms.order_items
    WHERE id=ANY(${sql.param(itemIds)}::int[]) ORDER BY id LIMIT ${MAX_ORDER_EVIDENCE_ROWS + 1} FOR SHARE`)
    ).rows,
  );
  const shipments = bounded(
    (
      await tx.execute(sql`SELECT item.id,item.order_item_id,item.qty,item.shipment_item_purpose,item.provider_membership_state,
    shipment.id AS shipment_id,shipment.status,shipment.voided_at,shipment.shipment_purpose
    FROM wms.outbound_shipment_items item JOIN wms.outbound_shipments shipment ON shipment.id=item.shipment_id
    WHERE item.order_item_id=ANY(${sql.param(itemIds)}::int[])
    ORDER BY shipment.id,item.id LIMIT ${MAX_ORDER_EVIDENCE_ROWS + 1} FOR SHARE OF shipment,item`)
    ).rows,
  );
  return { costs, orders, items, shipments };
}
