import { z } from "zod";
import { sql } from "drizzle-orm";
import { receiptReversalCapabilitySchema, receiptReversalIdSchema, type ReceiptReversalCapability } from "@shared/procurement/receipt-reversal-command";

export const SUPPLIER_RETURN_REVERSAL_REASON = "This receipt supplied stock that was returned to the supplier. Preserve its receipt history and review the supplier return instead of reversing the receipt.";
export function supplierReturnReversalCapability(hasReturn: boolean): ReceiptReversalCapability {
  return receiptReversalCapabilitySchema.parse(hasReturn
    ? { allowed: false, code: "RECEIPT_REVERSAL_SUPPLIER_RETURN_HISTORY", reason: SUPPLIER_RETURN_REVERSAL_REASON }
    : { allowed: true, code: null, reason: null });
}
const rowSchema = z.object({ id: receiptReversalIdSchema, has_return: z.boolean() }).strict();
type Reader = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };

/** Return lines retain their original receipt lineage through proven transfers.
 * No credit status can erase that physical fact. Writes call this under the same
 * inventory graph fence as return collection; reads are advisory capabilities. */
export async function readReceiptReturnCapabilities(tx: Reader, receivingOrderId: number) {
  const id = receiptReversalIdSchema.parse(receivingOrderId);
  const result = await tx.execute(sql`SELECT rl.id, EXISTS (
    SELECT 1 FROM procurement.supplier_return_lines sr WHERE sr.receiving_line_id=rl.id
  ) AS has_return FROM procurement.receiving_lines rl WHERE rl.receiving_order_id=${id} ORDER BY rl.id`);
  const rows = z.array(rowSchema).parse(result.rows);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate receipt line return evidence");
  return {
    order: supplierReturnReversalCapability(rows.some(row => row.has_return)),
    lines: new Map(rows.map(row => [row.id, supplierReturnReversalCapability(row.has_return)])),
  };
}
