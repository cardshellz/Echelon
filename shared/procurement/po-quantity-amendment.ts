import { z } from "zod";
import { PO_LINE_TYPES } from "./po-line-type";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

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
export const poQuantityChangesSchema = z.array(poQuantityChangeSchema).max(100).superRefine((changes, ctx) => {
  if (new Set(changes.map((change) => change.lineId)).size !== changes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each PO line may appear only once." });
  }
});
export const poAmendmentVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const poLineAdditionSchema = z.object({
  clientKey: z.string().uuid(), productId: poAmendmentIdSchema,
  expectedReceiveVariantId: poAmendmentIdSchema, expectedReceiveUnitsPerVariant: poAmendmentIdSchema,
  pricing: poCorrectionPricingSchema, packagingCostCents: money, discountCents: money, taxCents: money,
  vendorSku: z.string().trim().max(100).optional(), description: z.string().trim().max(20000).optional(),
}).strict();
const requestShape = {
  sourceVersion: poAmendmentVersionSchema,
  changes: poQuantityChangesSchema,
  additions: z.array(poLineAdditionSchema).max(100).optional(),
  removals: z.array(poAmendmentIdSchema).max(100).optional(),
  closedPurchaseOrderConfirmed: z.literal(true).optional(),
  reason: z.string().trim().min(10).max(2000),
};
function validateOperations(value: { changes: { lineId: number }[]; additions?: { clientKey: string }[]; removals?: number[] }, ctx: z.RefinementCtx) {
  const additions = value.additions ?? [], removals = value.removals ?? [];
  if (value.changes.length + additions.length + removals.length === 0) ctx.addIssue({ code: "custom", message: "Add, remove or edit at least one line." });
  if (new Set(additions.map(line => line.clientKey)).size !== additions.length || new Set(removals).size !== removals.length
    || value.changes.some(line => removals.includes(line.lineId))) ctx.addIssue({ code: "custom", message: "Each line can only be added, edited or removed once." });
}
export const poQuantityPreviewRequestSchema = z.object(requestShape).strict().superRefine(validateOperations);
// Optional in stored retry receipts from earlier releases; new approvals require
// the reviewed downstream fingerprint in the application service.
export const poQuantityApprovalRequestSchema = z.object({ ...requestShape, approvalConfirmed: z.literal(true), previewVersion: poAmendmentVersionSchema.optional() }).strict().superRefine(validateOperations);
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
  removalBlockedReason: z.string().nullable().optional(),
});
export const poQuantityAmendmentContextSchema = z.object({
  purchaseOrderId: poAmendmentIdSchema,
  currency: z.string(),
  sourceVersion: poAmendmentVersionSchema,
  canApprove: z.boolean(),
  closedPurchaseOrder: z.boolean().optional(),
  blockedReason: z.string().nullable(),
  additionBlockedReason: z.string().nullable().optional(),
  lines: z.array(poQuantityLineViewSchema),
  totalCents: money.optional(),
  invoiceIssues: z.array(z.object({
    invoiceId: poAmendmentIdSchema, invoiceNumber: z.string(), invoiceLineId: poAmendmentIdSchema,
    lineNumber: poAmendmentIdSchema, poLineId: poAmendmentIdSchema.nullable(), name: z.string(), status: z.string(),
    invoiceQuantity: money, orderedQuantity: money.nullable(), receivedQuantity: money.nullable(),
    invoiceLineAmountCents: money, poLineAmountCents: signedMoney.nullable(), currency: z.string(),
  }).strict()).optional(),
});
export const poQuantityAmendmentPreviewSchema = z.object({
  previewVersion: poAmendmentVersionSchema.optional(),
  impact: poAmendmentImpactSchema.optional(),
  purchaseOrderId: poAmendmentIdSchema,
  currency: z.string(),
  sourceVersion: poAmendmentVersionSchema,
  reason: z.string(),
  addedLines: z.array(z.object({
    clientKey: z.string().uuid(), lineNumber: poAmendmentIdSchema, productId: poAmendmentIdSchema,
    name: z.string(), sku: z.string().nullable(), expectedReceiveVariantId: poAmendmentIdSchema,
    expectedReceiveUnitsPerVariant: poAmendmentIdSchema, orderQty: poAmendmentIdSchema,
    unitCostMills: money, totalProductCostCents: money, packagingCostCents: money,
    discountCents: money, taxCents: money, lineTotalCents: money, sourceFingerprint: poAmendmentVersionSchema,
  }).strict()).optional(),
  removedLines: z.array(poQuantityLineViewSchema).optional(),
  lines: z.array(z.object({
    before: poQuantityLineViewSchema,
    after: poQuantityLineViewSchema,
    priceTreatment: z.enum(["keep_product_total", "keep_quoted_rate", "edit_line", "edit_charge"]),
  })),
  beforeTotalCents: money,
  afterTotalCents: money,
  beforeStatus: z.string(),
  closedPurchaseOrder: z.boolean().optional(),
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
export type PoLineAddition = z.infer<typeof poLineAdditionSchema>;
export type PoQuantityPreviewRequest = z.infer<typeof poQuantityPreviewRequestSchema>;
export type PoQuantityApprovalRequest = z.infer<typeof poQuantityApprovalRequestSchema>;
export type PoQuantityAmendmentContext = z.infer<typeof poQuantityAmendmentContextSchema>;
export type PoQuantityAmendmentPreview = z.infer<typeof poQuantityAmendmentPreviewSchema>;
export type PoQuantityAmendmentResult = z.infer<typeof poQuantityAmendmentResultSchema>;
export const poAmendmentHistorySchema = z.object({
  entries: z.array(z.object({ id: z.number().int().positive().safe(), actorId: z.string(), actorName: z.string(),
    approvedAt: z.string().datetime(), revisionNumber: z.number().int().positive(), preview: poQuantityAmendmentPreviewSchema }).strict()),
  nextCursor: z.number().int().positive().safe().nullable(),
}).strict();

/** One exact calculation shared by the server and the editable form. */
export function poLineAmountCents(productCents: number, packagingCents: number, discountCents: number, taxCents: number): number {
  for (const value of [productCents, packagingCents, discountCents, taxCents]) money.parse(value);
  const total = BigInt(productCents) + BigInt(packagingCents) - BigInt(discountCents) + BigInt(taxCents);
  if (total < BigInt(0) || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("The resulting line total is outside the supported range.");
  return Number(total);
}
