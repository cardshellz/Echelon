import { z } from "zod";

export const poAmendmentIdSchema = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().nonnegative().safe();
const signedMoney = z.number().int().safe();
export const poQuantityChangeSchema = z.object({
  lineId: poAmendmentIdSchema,
  quantityPieces: poAmendmentIdSchema,
  priceTreatment: z.enum(["keep_product_total", "keep_quoted_rate"]),
}).strict();
export const poQuantityChangesSchema = z.array(poQuantityChangeSchema).min(1).max(100).superRefine((changes, ctx) => {
  if (new Set(changes.map((change) => change.lineId)).size !== changes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each PO line may appear only once." });
  }
});
export const poAmendmentVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const poQuantityPreviewRequestSchema = z.object({
  sourceVersion: poAmendmentVersionSchema,
  changes: poQuantityChangesSchema,
  reason: z.string().trim().min(10).max(2000),
}).strict();
export const poQuantityApprovalRequestSchema = poQuantityPreviewRequestSchema.extend({ approvalConfirmed: z.literal(true) }).strict();
export const poQuantityLineViewSchema = z.object({
  id: poAmendmentIdSchema,
  lineNumber: poAmendmentIdSchema,
  name: z.string(),
  orderQty: z.number().int().nonnegative(),
  receivedQty: z.number().int().nonnegative(),
  invoicedQty: z.number().int().nonnegative().safe(),
  unitCostMills: money,
  totalProductCostCents: money,
  lineTotalCents: signedMoney,
  status: z.string(),
  blockedReason: z.string().nullable(),
});
export const poQuantityAmendmentContextSchema = z.object({
  purchaseOrderId: poAmendmentIdSchema,
  currency: z.string(),
  sourceVersion: poAmendmentVersionSchema,
  canApprove: z.boolean(),
  blockedReason: z.string().nullable(),
  lines: z.array(poQuantityLineViewSchema),
});
export const poQuantityAmendmentPreviewSchema = z.object({
  purchaseOrderId: poAmendmentIdSchema,
  currency: z.string(),
  sourceVersion: poAmendmentVersionSchema,
  reason: z.string(),
  lines: z.array(z.object({
    before: poQuantityLineViewSchema,
    after: poQuantityLineViewSchema,
    priceTreatment: poQuantityChangeSchema.shape.priceTreatment,
  })),
  beforeTotalCents: money,
  afterTotalCents: money,
  beforeStatus: z.string(),
  afterStatus: z.string(),
  warnings: z.array(z.string()),
  invoiceMatches: z.array(z.object({
    invoiceId: poAmendmentIdSchema,
    invoiceLineId: poAmendmentIdSchema,
    before: z.string(),
    after: z.string(),
  })),
});
export const poQuantityAmendmentResultSchema = z.object({
  purchaseOrderId: poAmendmentIdSchema,
  revisionNumber: z.number().int().positive(),
  auditEventId: z.number().int().positive().safe(),
  preview: poQuantityAmendmentPreviewSchema,
});
export type PoQuantityChange = z.infer<typeof poQuantityChangeSchema>;
export type PoQuantityPreviewRequest = z.infer<typeof poQuantityPreviewRequestSchema>;
export type PoQuantityApprovalRequest = z.infer<typeof poQuantityApprovalRequestSchema>;
export type PoQuantityAmendmentContext = z.infer<typeof poQuantityAmendmentContextSchema>;
export type PoQuantityAmendmentPreview = z.infer<typeof poQuantityAmendmentPreviewSchema>;
export type PoQuantityAmendmentResult = z.infer<typeof poQuantityAmendmentResultSchema>;
