import type { PoolClient } from "pg";
import { z } from "zod";
import { workEvidenceIdSchema } from "@shared/warehouse-assembly-work";

/** Caller already holds the order/items and parent claim. No inventory mutation. */
export async function lockAssemblyPackingPickEvidence(client: PoolClient, raw: {
  claimId: string; orderItemId: number; quantity: number;
}): Promise<boolean> {
  const input = z.object({ claimId: workEvidenceIdSchema, orderItemId: z.number().int().positive(), quantity: z.number().int().positive() }).strict().parse(raw);
  const result = await client.query(`SELECT id FROM inventory.availability_claim_lines
    WHERE claim_id=$1 AND order_item_id=$2 AND requested_qty=$3 AND planned_qty=$3
      AND picked_target_qty=$3 AND released_target_qty=0 AND consumed_target_qty=0 AND shortfall_qty=0
    ORDER BY id LIMIT 2 FOR UPDATE`, [input.claimId, input.orderItemId, String(input.quantity)]);
  return result.rows.length === 1;
}
