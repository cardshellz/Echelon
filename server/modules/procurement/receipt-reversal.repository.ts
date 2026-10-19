import { sql } from "drizzle-orm";
import type { ReceiptReversalTransaction } from "./receipt-reversal.service";

/** Literal comparison: legacy keys may contain SQL LIKE wildcard characters. */
export async function readReversalKeyEvidence(tx: ReceiptReversalTransaction, key: string): Promise<Record<string, any>[]> {
  const prefix = `${key}:line:`;
  return (await tx.execute(sql`
    SELECT id, receiving_order_id, receiving_line_id, qty, reason, reversal_scope,
           order_reversal_id, base_units_reversed, lot_unit_cost_mills, allow_negative,
           ap_reconciliation_reopened, idempotency_key, created_by
    FROM procurement.receipt_reversals
    WHERE idempotency_key = ${key} OR left(idempotency_key, length(${prefix})) = ${prefix}
    ORDER BY id
  `)).rows;
}
