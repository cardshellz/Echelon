import { z } from "zod";
import { costIssueSchema } from "./cost-source-contracts";
import { resolveCostPostingStatus } from "./cost-posting-status";
import { originRepairApprovalSchema } from "./cost-origin-repair";

const id = z.number().int().positive().safe();
export const purchaseCostComponentStatusSchema = z
  .object({
    component: z.enum(["product", "packaging"]),
    status: z.enum(["pending", "review_required", "applied"]),
    sourceEvidence: z.enum([
      "estimated",
      "confirmed",
      "review_required",
      "unknown",
    ]),
    sourceCurrent: z.boolean(),
    sourceRevisionId: id.nullable(),
    applicationId: id.nullable(),
    issues: z.array(costIssueSchema),
    historicalPosting: z.object({ destination: z.enum(["historical_cogs", "inventory_variance"]), amountMills: z.number().int().nonnegative().safe() }).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.status === "applied" &&
      (!value.sourceCurrent ||
        value.sourceRevisionId === null ||
        value.applicationId === null ||
        value.issues.length > 0 ||
        !["estimated", "confirmed"].includes(value.sourceEvidence))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Posted supplier costs require current source and application evidence.",
      });
    }
  });
export const purchaseLineCostStatusSchema = z
  .object({
    purchaseOrderId: id,
    purchaseOrderLineId: id,
    sku: z.string().nullable(),
    components: z.array(purchaseCostComponentStatusSchema).length(2),
    invoices: z.array(
      z.object({
        invoiceId: id,
        invoiceNumber: z.string(),
        lineId: id,
        lineNumber: id,
      }),
    ),
    receipts: z.array(
      z.object({
        receiptId: id,
        receiptNumber: z.string(),
        status: z.string(),
      }),
    ),
    lots: z.array(
      z.object({
        id,
        lotNumber: z.string(),
        onHandUnits: z.number().int().nonnegative().safe(),
        shipmentId: id.nullable(),
        provisional: z.boolean(),
        origin: z.enum(["receipt", "transformation", "unproven"]),
      }),
    ),
    originRepairs: z.array(originRepairApprovalSchema.extend({ lotId: id })).optional(),
  })
  .superRefine((line, context) => {
    if (
      new Set(line.components.map((component) => component.component)).size !==
      2
    )
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "Both product and packaging status are required.",
      });
  });
export const purchaseCostStatusSchema = z.object({
  lines: z.array(purchaseLineCostStatusSchema),
});
export type PurchaseLineCostStatus = z.infer<
  typeof purchaseLineCostStatusSchema
>;
export type PurchaseCostStatus = z.infer<typeof purchaseCostStatusSchema>;

/** This uses the same posting decision as landed costs. Product and packaging
 * never inherit a shipment approval: each component needs its own application. */
export function purchaseComponentPostingStatus(input: {
  sourceCurrent: boolean;
  issues: readonly unknown[];
  applicationStatus: string | null;
}) {
  return resolveCostPostingStatus({
    sourceCurrent: input.sourceCurrent,
    sourceIssue: input.issues.length > 0,
    applicationStatus: input.applicationStatus,
    reconciled: false,
  });
}

export function purchaseLineNeedsCostReview(
  line: PurchaseLineCostStatus,
): boolean {
  return line.components.some(
    (component) =>
      component.status !== "applied" ||
      component.sourceEvidence !== "confirmed",
  );
}

/** Resolve the next action from current component evidence, never a lot flag or
 * an old receipt attempt. Posting estimates is separate from confirming them. */
export function purchaseCostNextAction(
  line: PurchaseLineCostStatus,
): "invoice" | "history" | "review" | "apply" | "none" {
  if (line.components.some(component => component.issues.some(issue => issue.code === "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW"))) return "review";
  if (
    line.components.some(
      (component) =>
        component.sourceEvidence !== "confirmed" ||
        component.issues.some(
          (issue) =>
            issue.code.startsWith("INVOICE_") ||
            issue.code === "PURCHASE_ADJUSTMENT_REVIEW",
        ),
    )
  )
    return "invoice";
  if (
    line.components.some((component) =>
      component.issues.some(
        (issue) =>
          issue.code === "COST_HISTORICAL_LINEAGE_MISSING" ||
          issue.code === "COST_LINEAGE_UNPROVEN" ||
          issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED",
      ),
    )
  )
    return "history";
  return line.components.every((component) => component.status === "applied")
    ? "none"
    : "apply";
}
