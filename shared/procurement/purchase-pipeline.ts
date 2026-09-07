import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const pieces = z.number().int().nonnegative().safe();
const mills = z.string().regex(/^-?(0|[1-9]\d*)$/).max(100);
const date = z.string().datetime({ offset: true });
export const purchasePipelineStages = ["supplier_unconfirmed", "in_production", "ready_to_ship", "in_transit", "port_customs", "awaiting_receipt", "review"] as const;
export const supplierProgressReportSchema = z.object({
  startedPieces: pieces.max(2_147_483_647),
  completedPieces: pieces.max(2_147_483_647),
  asOf: date,
  reference: z.string().trim().min(1).max(255),
  notes: z.string().trim().max(2_000),
}).strict().superRefine((report, context) => {
  if (report.completedPieces > report.startedPieces) context.addIssue({ code: "custom", path: ["completedPieces"], message: "Completed pieces cannot exceed started pieces." });
});
export const supplierProgressSchema = z.object({
  revision: pieces,
  report: supplierProgressReportSchema.nullable(),
  recordedBy: z.string().nullable(),
  recordedAt: date.nullable(),
}).strict();
export const supplierProgressCommandSchema = z.object({
  expectedRevision: pieces,
  idempotencyKey: z.string().uuid(),
  report: supplierProgressReportSchema,
}).strict();
export const supplierProgressHistorySchema = z.object({
  purchaseOrderLineId: id,
  current: supplierProgressSchema,
  changes: z.array(z.object({ revision: pieces.positive(), before: supplierProgressReportSchema.nullable(), after: supplierProgressReportSchema, recordedBy: z.string(), recordedAt: date })).max(1_000),
}).strict();
const cost = z.object({
  component: z.enum(["product", "packaging", "landed"]),
  amountMills: mills.nullable(),
  evidence: z.enum(["estimated", "confirmed", "unknown", "review_required"]),
  source: z.enum(["purchase_quote", "recorded_revision", "missing"]),
  sourceRevisionId: pieces.positive().nullable(),
  recordedAt: date.nullable(),
  reference: z.string().nullable(),
}).strict();
export const purchasePipelineRowSchema = z.object({
  key: z.string(), purchaseOrderId: id, purchaseOrderLineId: id, poNumber: z.string(),
  vendorName: z.string(), sku: z.string().nullable(), productName: z.string().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  orderedPieces: pieces, cancelledPieces: pieces, receivedPieces: pieces.nullable(), remainingPieces: pieces.nullable(),
  stage: z.enum(purchasePipelineStages), quantityPieces: pieces.nullable(),
  shipmentId: id.nullable(), shipmentLineId: id.nullable(), shipmentNumber: z.string().nullable(),
  arrivalDate: date.nullable(), arrivalSource: z.enum(["shipment_eta", "line_promised", "line_expected", "purchase_confirmed", "purchase_expected"]).nullable(),
  arrivalBucket: z.enum(["overdue", "within_horizon", "later", "unknown", "arrived"]),
  arrivalDestination: z.enum(["shipment_destination", "warehouse", "unknown"]),
  costs: z.array(cost).length(3), progress: supplierProgressSchema,
  issues: z.array(z.string()),
}).strict();
export const purchasePipelineSchema = z.object({
  contractVersion: z.literal(1), asOf: date, horizonDays: z.union([z.literal(30), z.literal(90)]),
  rows: z.array(purchasePipelineRowSchema).max(50_000),
  totals: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(), stage: z.enum(purchasePipelineStages),
    knownPieces: pieces, quantityReviewRows: pieces,
    confirmedMills: mills, estimatedMills: mills, unknownComponentCount: pieces,
  }).strict()),
  issues: z.array(z.string()),
}).strict();
export type SupplierProgressReport = z.infer<typeof supplierProgressReportSchema>;
export type SupplierProgress = z.infer<typeof supplierProgressSchema>;
export type SupplierProgressCommand = z.infer<typeof supplierProgressCommandSchema>;
export type PurchasePipeline = z.infer<typeof purchasePipelineSchema>;
export type PurchasePipelineRow = z.infer<typeof purchasePipelineRowSchema>;
export type PurchasePipelineCost = z.infer<typeof cost>;
export const emptySupplierProgress = (): SupplierProgress => ({ revision: 0, report: null, recordedBy: null, recordedAt: null });

/** Display exact mills without ever passing a monetary amount through Number. */
export function formatPipelineMills(value: string, currency: string | null): string {
  const amount = BigInt(mills.parse(value));
  const absolute = amount < BigInt(0) ? -amount : amount;
  const whole = (absolute / BigInt(10_000)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < BigInt(0) ? "-" : ""}${whole}.${(absolute % BigInt(10_000)).toString().padStart(4, "0")} ${currency ?? "currency unknown"}`;
}
