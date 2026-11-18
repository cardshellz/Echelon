import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { poAmendmentImpactSchema } from "./po-amendment-impact";
import { invoiceCostComponentEvidenceSchema } from "./invoice-cost-evidence";
import { invoiceCorrectionCostImpactSchema } from "./invoice-correction-cost-impact";

const id = z.number().int().positive().max(2_147_483_647);
const auditId = z.number().int().positive().safe();
const money = z.number().int().nonnegative().safe();
export const purchaseTaxTreatmentSchema = z.enum(["inventory", "recoverable"]);
export const purchaseTaxTypeInputSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,39}$/, "Tax code must start with a letter and contain only letters, numbers or underscores (up to 40 characters)."),
  name: z.string().trim().min(1).max(100),
  treatment: purchaseTaxTreatmentSchema,
}).strict();
export const purchaseTaxTypeSchema = purchaseTaxTypeInputSchema.extend({ id, revision: id });
export const purchaseTaxEntrySchema = z.object({ taxTypeId: id, amountMills: money.refine(value => value % 100 === 0, "Enter the tax amount in whole cents.") }).strict();
export const purchaseTaxEntriesSchema = z.array(purchaseTaxEntrySchema).max(30).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.taxTypeId)).size !== rows.length)
    context.addIssue({ code: "custom", message: "Enter each tax type only once on an invoice line." });
});
export const purchaseTaxEvidenceSchema = z.object({
  taxTypeId: id.nullable(), treatment: z.enum(["inventory", "recoverable", "unclassified"]), amountMills: money,
  source: z.string().min(1).max(120),
}).strict();
export type PurchaseTaxEvidence = z.infer<typeof purchaseTaxEvidenceSchema>;
export type PurchaseTaxType = z.infer<typeof purchaseTaxTypeSchema>;

export const purchaseTaxTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tax_type"), id: id.nullable() }).strict(),
  z.object({ kind: z.literal("purchase_order"), id }).strict(),
  z.object({ kind: z.literal("invoice_line"), id }).strict(),
  z.object({ kind: z.literal("shipment_charge"), id }).strict(),
]);
export const purchaseTaxChangeSchema = z.discriminatedUnion("kind", [
  purchaseTaxTypeInputSchema.extend({ kind: z.literal("tax_type"), id: id.nullable() }).strict(),
  z.object({ kind: z.literal("purchase_order"), id, taxTypeId: id.nullable(),
    lineTypes: z.array(z.object({ lineId: id, taxTypeId: id.nullable() }).strict()).max(500),
  }).strict(),
  z.object({ kind: z.literal("invoice_line"), id, taxes: purchaseTaxEntriesSchema,
    components: invoiceCostComponentEvidenceSchema.refine(value => value.source === "operator_review", "Tax changes require explicit operator review."),
  }).strict(),
  z.object({ kind: z.literal("shipment_charge"), id, taxTypeId: id.nullable() }).strict(),
]);
export const purchaseTaxDocumentSchema = z.object({
  kind: z.enum(["purchase_order", "invoice", "shipment"]), id, reference: z.string(), currency: z.string(),
  taxMills: money, inventoryMills: money, recoverableMills: money, unclassifiedMills: money,
}).strict().superRefine((row, context) => {
  if ([row.taxMills, row.inventoryMills, row.recoverableMills, row.unclassifiedMills].every(Number.isSafeInteger)
    && BigInt(row.taxMills) !== BigInt(row.inventoryMills) + BigInt(row.recoverableMills) + BigInt(row.unclassifiedMills))
    context.addIssue({ code: "custom", message: "Every tax amount must have exactly one treatment." });
});
export const purchaseTaxApprovalHistorySchema = z.object({ auditEventId: auditId, actorName: z.string(), approvedAt: z.string().datetime(), reason: z.string(),
  preview: z.lazy(() => purchaseTaxPreviewSchema) }).strict();
export const purchaseTaxContextSchema = z.object({
  target: purchaseTaxTargetSchema, sourceVersion: costFingerprintSchema, canApprove: z.boolean(),
  types: z.array(purchaseTaxTypeSchema), current: purchaseTaxChangeSchema.nullable(),
  documents: z.array(purchaseTaxDocumentSchema),
  lines: z.array(z.object({ id, label: z.string(), taxMills: money, taxTypeId: id.nullable() }).strict()),
  invoice: z.object({ totalCents: money, currency: z.string().length(3), taxes: purchaseTaxEntriesSchema, components: invoiceCostComponentEvidenceSchema.nullable() }).strict().nullable(),
  approvals: z.array(purchaseTaxApprovalHistorySchema),
}).strict();
export const purchaseTaxPreviewRequestSchema = z.object({ sourceVersion: costFingerprintSchema, change: purchaseTaxChangeSchema }).strict();
export const purchaseTaxApprovalRequestSchema = purchaseTaxPreviewRequestSchema.extend({
  previewVersion: costFingerprintSchema, reason: z.string().trim().min(10).max(2000), approvalConfirmed: z.literal(true),
}).strict();
export const purchaseTaxImpactSchema = poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true, applications: true })
  .extend({ inventoryValues: invoiceCorrectionCostImpactSchema.innerType().shape.inventoryValues });
export const purchaseTaxPreviewSchema = z.object({
  sourceVersion: costFingerprintSchema, previewVersion: costFingerprintSchema, change: purchaseTaxChangeSchema,
  before: z.array(purchaseTaxDocumentSchema), after: z.array(purchaseTaxDocumentSchema),
  settings: z.array(z.object({ label: z.string().min(1).max(200), before: z.string().min(1).max(300), after: z.string().min(1).max(300) }).strict()).max(503),
  impact: purchaseTaxImpactSchema, warnings: z.array(z.string()),
}).strict();
export const purchaseTaxResultSchema = z.object({ auditEventId: auditId, preview: purchaseTaxPreviewSchema }).strict();
export type PurchaseTaxTarget = z.infer<typeof purchaseTaxTargetSchema>;
export type PurchaseTaxChange = z.infer<typeof purchaseTaxChangeSchema>;
export type PurchaseTaxContext = z.infer<typeof purchaseTaxContextSchema>;
export type PurchaseTaxPreview = z.infer<typeof purchaseTaxPreviewSchema>;

export const purchaseTaxTreatmentLabel = (value: z.infer<typeof purchaseTaxTreatmentSchema>) =>
  value === "inventory" ? "Include in inventory cost" : "Record separately as recoverable tax";
