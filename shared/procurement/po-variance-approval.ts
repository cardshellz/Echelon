import { z } from "zod";
const id = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().nonnegative().safe();
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const poVarianceApprovalRequestSchema = z.object({
  sourceVersion: version, reason: z.string().trim().min(10).max(2000), approvalConfirmed: z.literal(true),
}).strict();
export const poVarianceContextSchema = z.object({
  exceptionId: id, purchaseOrderId: id, sourceVersion: version, sourceFingerprint: version,
  invoiceId: id, invoiceNumber: z.string(), currency: z.string().regex(/^[A-Z]{3}$/),
  canApprove: z.boolean(), blockedReason: z.string().nullable(),
  issues: z.array(z.object({ lineId: id, lineNumber: id, name: z.string(),
    invoiceQuantity: money, orderedQuantity: money, receivedQuantity: money,
    invoiceUnitCostMills: money, poUnitCostMills: money, invoiceLineAmountCents: money,
    status: z.enum(["qty_discrepancy", "price_discrepancy", "over_billed"]),
  }).strict()).min(1),
}).strict();
export const poVarianceResultSchema = z.object({ exceptionId: id, auditEventId: id, context: poVarianceContextSchema }).strict();
export type PoVarianceApprovalRequest = z.infer<typeof poVarianceApprovalRequestSchema>;
export type PoVarianceContext = z.infer<typeof poVarianceContextSchema>;
