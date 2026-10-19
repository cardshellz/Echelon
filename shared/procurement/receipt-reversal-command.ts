import { z } from "zod";

export const RECEIPT_REVERSAL_MAX_QUANTITY = 2_147_483_647;
export const receiptReversalIdSchema = z.number().int().min(1).max(RECEIPT_REVERSAL_MAX_QUANTITY);
// The inventory quantity journal allows 1000 characters. Reserve 100 for the
// existing reversal/receipt audit prefix (receipt number <=50, numeric ID <=10).
export const RECEIPT_REVERSAL_MAX_REASON_LENGTH = 900;
const reason = z.string().trim().min(1).max(RECEIPT_REVERSAL_MAX_REASON_LENGTH);
export const receiptReversalOrderBodySchema = z.object({ reason, allowNegative: z.boolean().optional() }).strict();
export const receiptReversalLineBodySchema = receiptReversalOrderBodySchema.extend({ qty: receiptReversalIdSchema }).strict();
export type ReceiptReversalAction = "line" | "order";
export type ReceiptReversalLineInput = z.infer<typeof receiptReversalLineBodySchema>;
export type ReceiptReversalOrderInput = z.infer<typeof receiptReversalOrderBodySchema>;

export const receiptReversalLineResultSchema = z.object({
  reversalId: receiptReversalIdSchema,
  receivingOrderId: receiptReversalIdSchema,
  receivingLineId: receiptReversalIdSchema,
  qty: receiptReversalIdSchema,
  baseUnitsReversed: receiptReversalIdSchema,
  lotUnitCostMills: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  apReconciliationReopened: z.boolean(),
  idempotentReplay: z.boolean(),
}).strict();
export const receiptReversalOrderResultSchema = z.object({
  receivingOrderId: receiptReversalIdSchema,
  reversals: z.array(receiptReversalLineResultSchema).min(1),
  poStatusUpdate: z.object({ purchaseOrderId: receiptReversalIdSchema, legacyStatus: z.string().min(1), physicalStatus: z.string().min(1) }).strict().nullable(),
}).strict();
const identity = {
  targetId: receiptReversalIdSchema,
  actorId: z.string().min(1).max(100),
  idempotencyKey: z.string().min(8).max(200),
};
// Add identity to the existing flat response; old consumers retain their fields.
export const receiptReversalCommandResultSchema = z.discriminatedUnion("action", [
  receiptReversalLineResultSchema.extend({ ...identity, action: z.literal("line") }).strict(),
  receiptReversalOrderResultSchema.extend({ ...identity, action: z.literal("order") }).strict(),
]).superRefine((value, context) => {
  if (value.action === "line" && value.targetId !== value.receivingLineId) context.addIssue({ code: "custom", message: "Reversal line identity disagrees with its target" });
  if (value.action === "order") {
    if (value.targetId !== value.receivingOrderId) context.addIssue({ code: "custom", message: "Reversal order identity disagrees with its target" });
    const seen = new Set<number>();
    for (const line of value.reversals) {
      if (line.receivingOrderId !== value.receivingOrderId || seen.has(line.receivingLineId)) context.addIssue({ code: "custom", message: "Reversal group has contradictory or duplicate line identity" });
      seen.add(line.receivingLineId);
    }
  }
});
export type ReceiptReversalCommandResult = z.infer<typeof receiptReversalCommandResultSchema>;
