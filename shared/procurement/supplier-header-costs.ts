import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { purchaseTaxTypeSchema } from "./purchase-tax";
import { invoiceCorrectionCostImpactSchema } from "./invoice-correction-cost-impact";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

export const MAX_SUPPLIER_HEADER_ENTRIES = 30;
const id = z.number().int().positive().max(2_147_483_647);
const mills = z.number().int().safe().refine(value => value % 100 === 0, "Header shares must be entered in whole cents.");
export const supplierHeaderTargetSchema = z.object({ kind: z.enum(["purchase_order", "invoice"]), id }).strict();
export type SupplierHeaderTarget = z.infer<typeof supplierHeaderTargetSchema>;

export const supplierHeaderEntrySchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  label: z.string().trim().min(1).max(200),
  category: z.enum(["discount", "supplier_freight", "other", "tax"]),
  amountMills: mills,
  destination: z.enum(["product", "packaging", "landed", "excluded", "tax"]),
  taxTypeId: id.nullable(),
  method: z.enum(["by_value", "manual"]),
  shares: z.array(z.object({ lineId: id, amountMills: mills }).strict()).max(500),
}).strict().superRefine((entry, context) => {
  if (entry.category === "discount" && entry.amountMills > 0)
    context.addIssue({ code: "custom", message: "A discount must reduce the supplier amount." });
  if (entry.category === "tax"
    ? entry.destination !== "tax" || entry.taxTypeId === null || entry.amountMills < 0
    : entry.destination === "tax" || entry.taxTypeId !== null)
    context.addIssue({ code: "custom", message: "Tax must name its saved tax type; other charges must name their goods or excluded destination." });
  if (new Set(entry.shares.map(row => row.lineId)).size !== entry.shares.length)
    context.addIssue({ code: "custom", message: "Allocate each header entry to a line only once." });
  if (entry.method === "by_value" && entry.shares.length)
    context.addIssue({ code: "custom", message: "By-value allocation uses the reviewed rule, not manual shares." });
});
export type SupplierHeaderEntry = z.infer<typeof supplierHeaderEntrySchema>;
export const supplierHeaderEntriesSchema = z.array(supplierHeaderEntrySchema).max(MAX_SUPPLIER_HEADER_ENTRIES).superRefine((entries, context) => {
  if (new Set(entries.map(row => row.key)).size !== entries.length)
    context.addIssue({ code: "custom", message: "Every header entry needs a unique reference." });
});

export const supplierHeaderLineSchema = z.object({
  id, purchaseOrderLineId: id.nullable(), name: z.string(),
  kind: z.enum(["product", "shipment_charge", "unlinked"]), freightCostId: id.nullable(), inboundShipmentId: id.nullable(),
  basisMills: z.number().int().nonnegative().safe(),
  packagingTreatment: z.enum(["separate", "included_in_product", "combined", "unknown"]),
}).strict();
export type SupplierHeaderLine = z.infer<typeof supplierHeaderLineSchema>;
export const supplierHeaderFactSchema = z.object({ key: z.string(), label: z.string(),
  category: z.enum(["discount", "supplier_freight", "other"]), amountMills: mills,
  lineIds: z.array(id).max(500),
}).strict();
export const supplierHeaderSourceSchema = z.object({
  target: supplierHeaderTargetSchema, reference: z.string(), currency: z.literal("USD"),
  expectedMills: mills, facts: z.array(supplierHeaderFactSchema).max(500),
  lines: z.array(supplierHeaderLineSchema).max(500), types: z.array(purchaseTaxTypeSchema).max(1000),
  issues: z.array(z.string()).optional(),
}).strict();
export type SupplierHeaderSource = z.infer<typeof supplierHeaderSourceSchema>;
export function supplierHeaderEligibleLines(source: SupplierHeaderSource, entry: Pick<SupplierHeaderEntry, "key" | "destination">) {
  const parents = source.facts.find(fact => fact.key === entry.key)?.lineIds;
  return source.lines.filter(line => (!parents?.length || parents.includes(line.id))
    && (entry.destination === "excluded" || entry.destination === "tax" && line.kind !== "unlinked"
      || entry.destination === "landed" && line.kind === "shipment_charge"
      || ["product", "packaging"].includes(entry.destination) && line.kind === "product"));
}
const headerShareFields = {
  key: z.string(), label: z.string(), lineId: id, amountMills: mills,
  destination: z.enum(["product", "packaging", "landed", "excluded", "tax"]),
  taxTypeId: id.nullable(), taxTreatment: z.enum(["inventory", "recoverable"]).nullable(),
};
function validateHeaderShare(row: { destination: string; taxTypeId: number | null; taxTreatment: string | null; amountMills: number }, context: z.RefinementCtx) {
  if (row.destination === "tax"
    ? row.taxTypeId === null || row.taxTreatment === null || row.amountMills < 0
    : row.taxTypeId !== null || row.taxTreatment !== null)
    context.addIssue({ code: "custom", message: "Each tax share must retain its configured type and treatment; other shares cannot declare tax." });
}
export const supplierHeaderShareSchema = z.object(headerShareFields).strict().superRefine(validateHeaderShare);
export type SupplierHeaderShare = z.infer<typeof supplierHeaderShareSchema>;
export const supplierHeaderEconomicShareSchema = z.object(headerShareFields).omit({ label: true }).strict().superRefine(validateHeaderShare);
export const supplierHeaderEvidenceSchema = z.object({
  contractVersion: z.literal(1), sourceFingerprint: costFingerprintSchema, entries: supplierHeaderEntriesSchema,
}).strict();
export type SupplierHeaderEvidence = z.infer<typeof supplierHeaderEvidenceSchema>;
export const supplierHeaderPreviewInputSchema = z.object({
  target: supplierHeaderTargetSchema, sourceVersion: costFingerprintSchema, entries: supplierHeaderEntriesSchema,
  reason: z.string().trim().min(10).max(2000),
}).strict();
export const supplierHeaderApprovalInputSchema = supplierHeaderPreviewInputSchema.extend({
  previewVersion: costFingerprintSchema, approvalConfirmed: z.literal(true),
}).strict();
export const supplierHeaderPreviewSchema = z.object({
  target: supplierHeaderTargetSchema, sourceVersion: costFingerprintSchema, previewVersion: costFingerprintSchema,
  before: z.array(supplierHeaderShareSchema), after: z.array(supplierHeaderShareSchema),
  impact: poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true, applications: true }),
  inventoryValues: invoiceCorrectionCostImpactSchema.innerType().shape.inventoryValues,
  issues: z.array(z.string()),
}).strict();
export type SupplierHeaderPreview = z.infer<typeof supplierHeaderPreviewSchema>;
export const supplierHeaderApprovalSchema = z.object({
  reviewId: z.number().int().positive().safe(), actorName: z.string(), approvedAt: z.string().datetime(), reason: z.string(),
  preview: supplierHeaderPreviewSchema,
}).strict();
export const supplierHeaderContextSchema = z.object({
  source: supplierHeaderSourceSchema, sourceVersion: costFingerprintSchema,
  current: supplierHeaderEvidenceSchema.nullable(), proposed: supplierHeaderEntriesSchema,
  currentMatchesSource: z.boolean(), proposedShares: z.array(supplierHeaderShareSchema), proposedIssue: z.string().nullable(),
  canApprove: z.boolean(), blockedReason: z.string().nullable(), approvals: z.array(supplierHeaderApprovalSchema),
}).strict();
export type SupplierHeaderContext = z.infer<typeof supplierHeaderContextSchema>;
export const supplierHeaderResultSchema = z.object({
  reviewId: z.number().int().positive().safe(), preview: supplierHeaderPreviewSchema,
}).strict();
