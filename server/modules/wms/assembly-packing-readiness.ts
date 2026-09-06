import type { PoolClient } from "pg";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { transitionOrderStatus } from "../orders/order-status-core";
import { WmsOrderItemCommandError } from "./order-item-commands";
import { WMS_WAREHOUSE_STATUS_VALUES } from "@shared/enums/order-status";

const orderSchema = z.object({ id: z.number().int().positive(), warehouse_id: z.number().int().positive().nullable(),
  warehouse_status: z.enum(WMS_WAREHOUSE_STATUS_VALUES), on_hold: z.number().int() });
const itemSchema = z.object({ id: z.number().int().positive(), sku: z.string(), quantity: z.number().int().nonnegative(),
  picked_quantity: z.number().int().nonnegative(), status: z.string(), on_hold: z.boolean(),
  requires_shipping: z.number().int(), location: z.string().nullable() });
export interface PackingReadiness {
  order: z.infer<typeof orderSchema>; items: z.infer<typeof itemSchema>[]; exceptionIds: number[];
}
/** WMS order/item fence comes before claim, inventory-work, and station locks. */
export async function lockPackingReadiness(client: PoolClient, orderId: number): Promise<PackingReadiness> {
  z.number().int().positive().parse(orderId);
  const result = await client.query("SELECT id, warehouse_id, warehouse_status, on_hold FROM wms.orders WHERE id=$1 FOR UPDATE", [orderId]);
  if (!result.rows[0]) throw new WmsOrderItemCommandError("WORK_ORDER_NOT_FOUND", "Order not found");
  const items = await client.query("SELECT id, sku, quantity, picked_quantity, status, on_hold, requires_shipping, location FROM wms.order_items WHERE order_id=$1 ORDER BY id LIMIT 1001 FOR UPDATE", [orderId]);
  const exceptions = await client.query<{ id: number }>(`SELECT id FROM wms.allocation_exceptions WHERE order_id=$1
    AND status NOT IN ('resolved','resolved_inline','cancelled')
    AND (status='blocked' OR COALESCE(metadata->>'shipmentBlocking','false')='true') ORDER BY id LIMIT 1001 FOR UPDATE`, [orderId]);
  return { order: orderSchema.parse(result.rows[0]), items: z.array(itemSchema).max(1000).parse(items.rows),
    exceptionIds: z.array(z.number().int().positive()).max(1000).parse(exceptions.rows.map((row) => row.id)) };
}
/** Pure readiness rule: no stock movement and no assumption that a label is valid. */
export function packingReadinessBlockers(evidence: PackingReadiness, warehouseId: number, taskItemId: number, replenIds: readonly number[]): string[] {
  const blockers: string[] = [];
  if (evidence.order.warehouse_id !== warehouseId) blockers.push("Order warehouse differs from the assembly job or is unknown");
  if (evidence.order.on_hold !== 0) blockers.push("Order is held");
  if (!["in_progress", "picking", "picked", "ready_to_ship"].includes(evidence.order.warehouse_status)) blockers.push("Order is not in a packing-handoff state");
  const items = evidence.items.filter((item) => item.requires_shipping === 1 && !item.on_hold && item.status !== "cancelled" && item.quantity > 0);
  if (!items.some((item) => item.id === taskItemId)) blockers.push("Assembly line is not eligible physical work");
  for (const item of items) {
    if (item.status !== "completed" || item.picked_quantity !== item.quantity) blockers.push(`${item.sku}: pick incomplete`);
    if (!item.location?.trim() || item.location === "UNASSIGNED") blockers.push(`${item.sku}: pick location missing`);
  }
  if (evidence.exceptionIds.length) blockers.push("Unresolved shipment-blocking allocation exceptions");
  if (replenIds.length) blockers.push("Unresolved shipment-blocking replenishment work");
  return blockers;
}
export async function recordAssemblyPackingReady(client: PoolClient, evidence: PackingReadiness, clock: () => Date): Promise<void> {
  if (evidence.order.warehouse_status === "ready_to_ship") return;
  const dialect = new PgDialect();
  const executor = { execute: (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    return client.query(query.sql, query.params);
  } };
  const result = await transitionOrderStatus(executor, evidence.order.id, {
    from: [evidence.order.warehouse_status], to: "ready_to_ship", reason: "assembly_packing_handoff",
  }, clock);
  if (!result.transitioned) throw new WmsOrderItemCommandError("WORK_ORDER_CHANGED", "Order changed before packing handoff");
}
