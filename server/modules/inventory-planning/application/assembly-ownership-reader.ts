import type { PoolClient } from "pg";
import { z } from "zod";
import { assemblyOwnershipSchema, type AssemblyOwnership } from "@shared/warehouse-assembly-execution";

/** Inventory planning's read-only ownership projection, not an ATP calculation.
 * Only root component builds still owned by an active canonical claim qualify.
 * A release/replacement removes coverage; completed builds retain custody until picked.
 */
export async function readAssemblyOwnership(client: PoolClient, rawOrderIds: readonly number[]): Promise<AssemblyOwnership[]> {
  const ids = z.array(z.number().int().positive()).max(200).parse([...new Set(rawOrderIds)]);
  if (ids.length === 0) return [];
  const result = await client.query(`
    SELECT claim.order_id AS "orderId", line.order_item_id AS "orderItemId",
      claim.id::text AS "claimId", operation.id::text AS "operationId",
      line.requested_qty::text AS "requestedQty", operation.committed_output_qty::text AS "committedQty"
    FROM inventory.availability_claims claim
    JOIN inventory.availability_claim_lines line ON line.claim_id=claim.id
    JOIN inventory.availability_claim_operations operation ON operation.claim_id=claim.id AND operation.claim_line_id=line.id
    WHERE claim.order_id=ANY($1::integer[]) AND claim.status='active'
      AND operation.operation_type='component_build' AND operation.parent_operation_key IS NULL
      AND operation.destination_variant_id=line.target_variant_id
      AND operation.status IN ('pending','ready','executing','completed')
      AND operation.released_executions=0 AND line.released_target_qty=0 AND line.consumed_target_qty=0
      AND line.shortfall_qty=0 AND line.planned_qty=line.requested_qty
      AND EXISTS (SELECT 1 FROM inventory.availability_runtime_authority WHERE singleton_key=true
        AND authority='canonical' AND activation_run_id IS NOT NULL)
    ORDER BY claim.order_id, line.order_item_id, operation.id LIMIT 10001`, [ids]);
  return z.array(assemblyOwnershipSchema).max(10000).parse(result.rows);
}
