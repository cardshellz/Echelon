import type { PoolClient } from "pg";
import { z } from "zod";

/** Read/lock existing blocker evidence; never resolve, cancel, create, or post replenishment. */
export async function lockPackingReplenishmentBlockers(client: PoolClient, orderId: number): Promise<number[]> {
  z.number().int().positive().parse(orderId);
  const result = await client.query<{ id: number }>(`SELECT id FROM inventory.replen_tasks WHERE order_id=$1
    AND blocks_shipment=TRUE AND status NOT IN ('completed','cancelled') ORDER BY id LIMIT 1001 FOR UPDATE`, [orderId]);
  return z.array(z.number().int().positive()).max(1000).parse(result.rows.map((row) => row.id));
}
