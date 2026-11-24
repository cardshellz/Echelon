import type { PoolClient } from "pg";
import { z } from "zod";

const itemSchema = z.object({
  id: z.number().int().positive(), sku: z.string(), name: z.string(),
  quantity: z.number().int().nonnegative(), picked_quantity: z.number().int().nonnegative(),
  status: z.string(), on_hold: z.boolean(), requires_shipping: z.number(),
});
const orderSchema = z.object({
  id: z.number().int().positive(), order_number: z.string(), warehouse_status: z.string(),
  assigned_picker_id: z.string().nullable(), on_hold: z.number().nullable(),
});
/** WMS's published read boundary. No stock/assignment/status writes. */
export async function readAssemblyOrder(client: PoolClient, orderId: number) {
  const order = await client.query("SELECT id, order_number, warehouse_status, assigned_picker_id, on_hold FROM wms.orders WHERE id=$1", [orderId]);
  if (!order.rows[0]) return null;
  const items = await client.query("SELECT id, sku, name, quantity, picked_quantity, status, on_hold, requires_shipping FROM wms.order_items WHERE order_id=$1 ORDER BY id LIMIT 1001", [orderId]);
  return { ...orderSchema.parse(order.rows[0]), items: z.array(itemSchema).max(1000).parse(items.rows) };
}
