import { z } from "zod";
const quantity = z.number().int().nonnegative().safe();
/** Identifies a saved invoice/receipt assignment, never today's lot balance. */
export const receiptCreditAttributionSchema = z.object({
  receivingLineId: z.number().int().positive().max(2_147_483_647),
  receiptStartPiece: quantity,
  invoiceStartPiece: quantity,
  pieces: quantity.positive(),
}).strict().superRefine(validateReceiptCreditAttribution);
export function validateReceiptCreditAttribution(row: { receiptStartPiece: number; invoiceStartPiece: number; pieces: number }, context: z.RefinementCtx) {
  if ([row.receiptStartPiece, row.invoiceStartPiece, row.pieces].every(Number.isSafeInteger)
    && [row.receiptStartPiece, row.invoiceStartPiece].some(start => BigInt(start) + BigInt(row.pieces) > BigInt(Number.MAX_SAFE_INTEGER)))
    context.addIssue({ code: "custom", message: "The receipt credit interval exceeds the supported quantity." });
}
export type ReceiptCreditAttribution = z.infer<typeof receiptCreditAttributionSchema>;
export function receiptCreditAttributionKey(row: ReceiptCreditAttribution): string {
  return `${row.receivingLineId}:${row.receiptStartPiece}:${row.invoiceStartPiece}:${row.pieces}`;
}
