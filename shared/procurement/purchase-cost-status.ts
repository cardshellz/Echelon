import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json";
import { costInventoryEffectSchema, costIssueSchema, type CostInventoryEffect } from "./cost-source-contracts";
import { resolveCostPostingStatus } from "./cost-posting-status";
import { originRepairApprovalSchema } from "./cost-origin-repair";

function inventoryEffectIdentity(effect: CostInventoryEffect): string {
  return canonicalJson({ ...effect, returns: [...effect.returns].sort((a, b) => a.supplierCreditLineId - b.supplierCreditLineId) });
}

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
    inventoryEffect: costInventoryEffectSchema.optional(),
    historicalPosting: z.object({ destination: z.enum(["historical_cogs", "inventory_variance"]), amountMills: z.number().int().nonnegative().safe() }).optional(),
  })
  .superRefine((value, context) => {
    if (value.inventoryEffect && (value.status !== "applied" || value.sourceEvidence !== "confirmed"
      || !value.sourceCurrent || value.sourceRevisionId === null || value.applicationId === null
      || value.issues.length > 0 || value.historicalPosting)) {
      context.addIssue({ code: "custom", message: "A verified no-inventory outcome requires current confirmed application evidence and no historical cost posting." });
    }
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
    const effects = line.components.flatMap(component => component.inventoryEffect ? [component.inventoryEffect] : []);
    if (effects.length > 0 && line.lots.length > 0) {
      context.addIssue({ code: "custom", path: ["lots"], message: "A return before acceptance cannot have inventory lot evidence." });
    }
    // Nested validation can retain dirty numbers. Never canonicalize an invalid
    // effect while collecting boundary errors.
    if (effects.length === 2 && effects.every(effect => costInventoryEffectSchema.safeParse(effect).success)
      && inventoryEffectIdentity(effects[0]) !== inventoryEffectIdentity(effects[1])) {
      context.addIssue({ code: "custom", path: ["components"], message: "Product and packaging return completion must use matching evidence." });
    }
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

/** Both component owners must verify the same disposition before the whole line
 * can be described as complete without an inventory or sold-cost change. */
export function purchaseLineInventoryEffect(line: PurchaseLineCostStatus): CostInventoryEffect | null {
  const components = line.components;
  if (components.length !== 2 || new Set(components.map(component => component.component)).size !== 2) return null;
  const effect = components[0].inventoryEffect;
  if (!effect || components.some(component => !component.inventoryEffect || component.status !== "applied"
    || component.sourceEvidence !== "confirmed" || !component.sourceCurrent || component.issues.length > 0
    || component.sourceRevisionId === null || component.applicationId === null || component.historicalPosting)) return null;
  return components.every(component => inventoryEffectIdentity(component.inventoryEffect!) === inventoryEffectIdentity(effect)) ? effect : null;
}
