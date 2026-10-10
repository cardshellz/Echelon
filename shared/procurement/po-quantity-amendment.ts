import { z } from "zod";
import { PO_LINE_TYPES } from "./po-line-type";

export const poAmendmentIdSchema = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().nonnegative().safe();
const signedMoney = z.number().int().safe();
export const poCorrectionPricingSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("per_piece"), quantityPieces: poAmendmentIdSchema, unitCostMills: money }).strict(),
  z.object({ basis: z.literal("extended_total"), quantityPieces: poAmendmentIdSchema, quotedTotalCents: money }).strict(),
  z.object({ basis: z.literal("per_purchase_uom"), purchaseUom: z.string().trim().min(1).max(50),
    uomQuantity: poAmendmentIdSchema, piecesPerUom: poAmendmentIdSchema, quotedCostMillsPerUom: money }).strict(),
]);
export const poQuantityChangeSchema = z.object({
  lineId: poAmendmentIdSchema,
  quantityPieces: poAmendmentIdSchema,
  priceTreatment: z.enum(["keep_product_total", "keep_quoted_rate", "edit_line", "edit_charge"]),
  pricing: poCorrectionPricingSchema.optional(), packagingCostCents: money.optional(),
  discountCents: money.optional(), taxCents: money.optional(), chargeTotalCents: signedMoney.optional(),
}).strict().superRefine((change, ctx) => {
  const fields = [change.pricing, change.packagingCostCents, change.discountCents, change.taxCents];
  if (change.priceTreatment === "edit_line") {
    if (fields.some(value => value === undefined) || change.chargeTotalCents !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Review product pricing, packaging, discount and tax for a line correction." });
  } else if (change.priceTreatment === "edit_charge") {
    if (change.chargeTotalCents === undefined || fields.some(value => value !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the charge or credit amount." });
  } else if (fields.some(value => value !== undefined) || change.chargeTotalCents !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Explicit amounts require a line correction." });
  }
});
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
  unitCostMills: signedMoney,
  totalProductCostCents: money,
  // Optional only for receipts of already-committed legacy quantity commands.
  // New context responses always provide these fields; the editor requires them.
  packagingCostCents: money.optional(), discountCents: money.optional(), taxCents: money.optional(),
  componentTotalCents: signedMoney.optional(), lineType: z.enum(PO_LINE_TYPES).optional(),
  pricing: poCorrectionPricingSchema.nullable().optional(),
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
    priceTreatment: z.enum(["keep_product_total", "keep_quoted_rate", "edit_line", "edit_charge"]),
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

/** One exact calculation shared by the server and the editable form. */
export function poLineAmountCents(productCents: number, packagingCents: number, discountCents: number, taxCents: number): number {
  for (const value of [productCents, packagingCents, discountCents, taxCents]) money.parse(value);
  const total = BigInt(productCents) + BigInt(packagingCents) - BigInt(discountCents) + BigInt(taxCents);
  if (total < BigInt(0) || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("The resulting line total is outside the supported range.");
  return Number(total);
}
