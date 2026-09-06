import type { PoolClient } from "pg";
import { workEvidenceIdSchema } from "@shared/warehouse-assembly-work";

/**
 * Published claim-owner boundary for NON-INVENTORY work-state commands only.
 * Acquire the WMS order/item fence first, then this claim fence before warehouse
 * task/identity locks. These commands
 * must never call build, pick, release or acquire graph/resource locks afterward.
 * Canonical posting retains its existing authority -> graph -> order -> claim ->
 * resource order, and invokes the warehouse owner inside that same transaction.
 */
export async function lockAssemblyClaimForWork(client: PoolClient, rawClaimId: string): Promise<{ active: boolean }> {
  const claimId = workEvidenceIdSchema.parse(rawClaimId);
  const result = await client.query<{ status: string }>(
    "SELECT status FROM inventory.availability_claims WHERE id=$1 FOR UPDATE", [claimId]);
  return { active: result.rows[0]?.status === "active" };
}
