import { z } from "zod";
import { readUnresolvedReceivingCustody } from "../../procurement/receiving-custody-public";
import { InventoryQuantityError } from "../domain/quantity-ledger";
import type { InventoryQuantityTransaction } from "./quantity-ledger.port";
import { costEvidenceTransactionFromPg } from "../infrastructure/cost-evidence-pg";

const identitySchema = z.object({
  warehouseLocationId: z.number().int().positive().max(2_147_483_647),
  productVariantId: z.number().int().positive().max(2_147_483_647),
}).strict();
const conflictsSchema = z.array(z.object({
  custodyId: z.string().regex(/^[1-9][0-9]*$/),
  receivingOrderId: z.number().int().positive(),
  productId: z.number().int().positive().nullable(),
}).strict());

/** Pending custody is physical evidence, not authority to manufacture saleable
 * stock from a count. The procurement read owner holds the shared custody fence
 * until this transaction commits and rejects an obsolete serializable snapshot.
 */
export async function assertReceivingCustodyCountable(
  transaction: InventoryQuantityTransaction,
  input: { warehouseLocationId: number; productVariantId: number },
): Promise<void> {
  const identity = identitySchema.parse(input);
  const conflicts = conflictsSchema.parse(await readUnresolvedReceivingCustody(costEvidenceTransactionFromPg(transaction), identity));
  if (conflicts.length === 0) return;
  const receivingOrderIds = [...new Set(conflicts.map(row => row.receivingOrderId))].sort((a, b) => a - b);
  throw new InventoryQuantityError(
    "RECEIVING_CUSTODY_COUNT_CONFLICT",
    `Resolve receiving quarantine for receipt ${receivingOrderIds.join(", ")} before counting or adding stock at this location. Held goods must not be counted as available inventory.`,
    { ...identity, receivingOrderIds, custodyIds: conflicts.map(row => row.custodyId) },
  );
}
