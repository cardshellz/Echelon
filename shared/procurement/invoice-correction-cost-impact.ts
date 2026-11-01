import { z } from "zod";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

const selectedAmount = z.object({
  totalMills: z.number().int().nonnegative().safe().nullable(),
  basePieces: z.number().int().nonnegative().safe().nullable(),
  evidence: z.enum(["estimated", "confirmed", "review_required", "unknown"]),
}).strict();

/** Financial effects measured by the existing cost owners, never estimated by
 * the editor. Generated revision/application IDs are excluded from approval
 * identity because preview writes are rolled back. */
export const invoiceCorrectionCostImpactSchema = poAmendmentImpactSchema.pick({
  lots: true, orderCosts: true, historicalCosts: true, applications: true,
}).extend({
  purchaseOrderLineId: z.number().int().positive().safe(),
  needsReview: z.boolean(),
  reviewTasks: z.array(z.object({ id: z.string(), title: z.string(), explanation: z.string() }).strict()),
  inventoryValues: z.array(z.object({
    lotId: z.number().int().positive().safe(), lotNumber: z.string(), onHandUnits: z.number().int().nonnegative().safe(),
    originalLotTotalMills: z.object({ before: z.number().int().nonnegative().safe().nullable(), after: z.number().int().nonnegative().safe().nullable() }).strict(),
    onHandValueMills: z.object({ before: z.number().int().nonnegative().safe().nullable(), after: z.number().int().nonnegative().safe().nullable() }).strict(),
    valueReviewReason: z.string().nullable(),
  }).strict()),
  sourceAmounts: z.array(z.object({
    component: z.enum(["product", "packaging"]),
    before: selectedAmount,
    after: selectedAmount,
  }).strict()).length(2),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceAmounts.map(row => row.component)).size !== 2) {
    context.addIssue({ code: "custom", message: "Both supplier cost components must be reviewed." });
  }
  if (value.applications.length !== 2 || new Set(value.applications.map(row => row.component)).size !== 2
    || value.applications.some(row => row.component === "landed" || row.purchaseOrderLineId !== value.purchaseOrderLineId
      || row.shipmentId !== null || (row.status === "applied" && row.issues.length > 0))) {
    context.addIssue({ code: "custom", message: "Correction applications must match both supplier components and this purchase line." });
  }
  if (!value.needsReview && (value.reviewTasks.length > 0 || value.applications.some(row => row.status !== "applied")
    || value.sourceAmounts.some(row => row.after.evidence !== "confirmed"))) {
    context.addIssue({ code: "custom", message: "Completed supplier costs require confirmed sources, applied components and no remaining task." });
  }
});
export type InvoiceCorrectionCostImpact = z.infer<typeof invoiceCorrectionCostImpactSchema>;
