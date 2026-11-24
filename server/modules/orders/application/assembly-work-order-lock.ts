import type { PoolClient } from "pg";

/**
 * WMS's non-inventory work fence: order -> item, then the caller may lock its
 * canonical claim. Never acquire these locks after a claim/task lock.
 * Return facts rather than rejecting held/terminal work here so an authenticated
 * caller can still replay a receipt or record a blocked-work observation.
 */
export async function lockAssemblyOrderForWork(client: PoolClient, input: {
  orderId: number; orderItemId: number;
}): Promise<{ executable: boolean }> {
  const orders = await client.query<{ warehouse_status: string; on_hold: number | null }>(
    "SELECT warehouse_status, on_hold FROM wms.orders WHERE id=$1 FOR UPDATE", [input.orderId]);
  const items = await client.query<{ status: string; on_hold: boolean; requires_shipping: number }>(
    "SELECT status, on_hold, requires_shipping FROM wms.order_items WHERE order_id=$1 AND id=$2 FOR UPDATE", [input.orderId, input.orderItemId]);
  const order = orders.rows[0]; const item = items.rows[0];
  const unheld = (value: number | null) => value === 0 || value === null;
  return { executable: !!order && !!item && item.requires_shipping === 1
    && unheld(order.on_hold) && item.on_hold === false
    && !["cancelled", "shipped"].includes(order.warehouse_status)
    && !["cancelled", "completed", "short"].includes(item.status) };
}
