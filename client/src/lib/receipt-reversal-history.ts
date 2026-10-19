import { z } from "zod";
import { receiptReversalIdSchema } from "@shared/procurement/receipt-reversal-command";

const historyRowSchema = z.object({
  id: receiptReversalIdSchema, receivingOrderId: receiptReversalIdSchema, receivingLineId: receiptReversalIdSchema,
  qty: receiptReversalIdSchema, reason: z.string().min(1), reversalScope: z.enum(["line", "order"]),
  orderReversalId: receiptReversalIdSchema.nullable(), baseUnitsReversed: receiptReversalIdSchema.nullable(),
  lotUnitCostMills: z.number().int().nonnegative().safe().nullable(), allowNegative: z.boolean(), apReconciliationReopened: z.boolean(),
  idempotencyKey: z.string().min(1), createdBy: z.string().nullable(), createdAt: z.string().datetime({ offset: true }),
}).strict();
export type ReceiptReversalHistoryRow = z.infer<typeof historyRowSchema>;

/** Unavailable or inconsistent audit evidence is never presented as an empty history. */
export function parseReceiptReversalHistory(raw: unknown, receivingOrderId: number): ReceiptReversalHistoryRow[] {
  const parsed = z.array(historyRowSchema).safeParse(raw);
  if (!parsed.success || parsed.data.some(row => row.receivingOrderId !== receivingOrderId)
    || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) {
    throw new Error("Receipt reversal history could not be verified. Retry to load the recorded corrections.");
  }
  return parsed.data;
}
