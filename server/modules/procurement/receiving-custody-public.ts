import { sql } from "drizzle-orm";
import { z } from "zod";
import { readVariantProductIdentity } from "../catalog/variant-product.reader";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { ReceivingIntegrityTransaction } from "./receiving-close-integrity.repository";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";

export async function lockReceivingCustodyFence(tx: ReceivingIntegrityTransaction, mode: "read" | "write"): Promise<void> {
  // SAVEPOINT fails in autocommit: a guard cannot protect a later independent write.
  await tx.execute(sql`SAVEPOINT receiving_custody_transaction_check`);
  await tx.execute(sql`RELEASE SAVEPOINT receiving_custody_transaction_check`);
  await lockInventoryCostGraph(tx);
  const rows = mode === "write"
    ? (await tx.execute(sql`UPDATE procurement.receiving_custody_fence SET revision=revision+1 WHERE singleton=true RETURNING singleton`)).rows
    : (await tx.execute(sql`SELECT singleton FROM procurement.receiving_custody_fence WHERE singleton=true FOR SHARE`)).rows;
  if (rows.length !== 1) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_FENCE_MISSING", "Receiving custody protection is unavailable. Contact an administrator.", 503);
}

/** A count cannot distinguish held goods from available stock. Unknown goods
 * block the whole location; known goods block every pack of that base product.
 * The persisted fence also rejects an obsolete SERIALIZABLE snapshot (40001).
 */
export async function readUnresolvedReceivingCustody(tx: ReceivingIntegrityTransaction, input: {
  warehouseLocationId: number; productVariantId: number;
}): Promise<readonly { custodyId: string; receivingOrderId: number; productId: number | null }[]> {
  const parsed = z.object({ warehouseLocationId: z.number().int().positive(), productVariantId: z.number().int().positive() }).strict().parse(input);
  await lockReceivingCustodyFence(tx, "read");
  const productId = await readVariantProductIdentity(tx, parsed.productVariantId);
  return z.array(z.object({ custodyId: z.string(), receivingOrderId: z.number().int().positive(), productId: z.number().int().positive().nullable() })).parse((await tx.execute(sql`
    SELECT id::text AS "custodyId",receiving_order_id AS "receivingOrderId",product_id AS "productId"
    FROM procurement.receiving_quarantine_observations
    WHERE holding_location_id=${parsed.warehouseLocationId} AND (product_id IS NULL OR product_id=${productId})
      AND observed_qty>received_qty+returned_qty ORDER BY id
  `)).rows);
}
