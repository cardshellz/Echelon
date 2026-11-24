import type { PoolClient } from "pg";
import { z } from "zod";
import { WmsOrderItemCommandError } from "./order-item-commands";

const evidenceSchema = z.object({
  orderId: z.number().int().positive(), orderItemId: z.number().int().positive(),
  locationCode: z.string().min(1).max(50), zone: z.string().max(10).nullable(),
}).strict();
/** Canonical caller already owns order/item locks. No stock, assignment, or shipment-state changes. */
export async function recordAssemblyOutputPickLocation(client: PoolClient, rawInput: z.infer<typeof evidenceSchema>): Promise<void> {
  const input = evidenceSchema.parse(rawInput);
  const result = await client.query(`UPDATE wms.order_items SET location=$1, zone=$2
    WHERE id=$3 AND order_id=$4 AND status='completed' RETURNING id`,
  // U is the WMS schema's existing unknown-zone marker, not an invented stock location.
  [input.locationCode, input.zone ?? "U", input.orderItemId, input.orderId]);
  if (result.rowCount !== 1) throw new WmsOrderItemCommandError("WMS_PICK_PROGRESS_CHANGED", "Assembly output pick did not materialize its WMS line", { orderId: input.orderId, orderItemId: input.orderItemId });
}
