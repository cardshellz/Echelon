import type { PoolClient } from "pg";

export class AssemblyOrderAuthorityError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown>) { super(message); }
}

/** WMS-owned read guard; canonical caller already holds order and item locks. */
export async function requireAssemblyOrderAuthority(client: PoolClient, input: {
  orderId: number; orderItemId: number; actorId: string; action: "handoff" | "complete";
}): Promise<void> {
  const result = await client.query<{
    warehouse_status: string; on_hold: number; assigned_picker_id: string | null;
    item_on_hold: boolean; item_status: string; requires_shipping: number;
  }>(`
    SELECT orders.warehouse_status, orders.on_hold, orders.assigned_picker_id,
      item.on_hold AS item_on_hold, item.status AS item_status, item.requires_shipping
    FROM wms.orders AS orders JOIN wms.order_items AS item ON item.order_id=orders.id
    WHERE orders.id=$1 AND item.id=$2
  `, [input.orderId, input.orderItemId]);
  const row = result.rows[0];
  if (!row || row.requires_shipping !== 1 || row.on_hold !== 0 || row.item_on_hold !== false
    || ["shipped", "cancelled"].includes(row.warehouse_status) || ["cancelled", "completed", "short"].includes(row.item_status)) {
    throw new AssemblyOrderAuthorityError("WORK_ORDER_NOT_EXECUTABLE", "The order or line is held, terminal, or not physical warehouse work", { orderId: input.orderId, orderItemId: input.orderItemId });
  }
  if (input.action === "handoff" && row.assigned_picker_id !== input.actorId) {
    throw new AssemblyOrderAuthorityError("WORK_ORDER_PICKER_MISMATCH", "Only this order's assigned picker can send its assembly work", { orderId: input.orderId });
  }
}
