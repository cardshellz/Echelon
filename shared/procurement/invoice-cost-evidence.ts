import { z } from "zod";
import { invoiceCostAdjustmentsSchema, invoiceAdjustmentAmounts } from "./invoice-cost-adjustments";
import { readIntegerMills } from "../money-read";

export const invoiceCostComponentFields = {
  packagingTreatment: z.enum(["separate", "included_in_product", "combined"]),
  productMills: z.number().int().nonnegative().safe(),
  packagingMills: z.number().int().nonnegative().safe(),
  adjustmentMills: z.number().int().safe(),
  adjustments: invoiceCostAdjustmentsSchema.optional(),
};

export function validateInvoiceCostPackaging(
  value: { packagingTreatment: string; packagingMills: number; adjustments?: z.infer<typeof invoiceCostAdjustmentsSchema> }, context: z.RefinementCtx,
): void {
  if (value.packagingTreatment !== "separate" && value.packagingMills !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["packagingMills"], message: value.packagingTreatment === "combined"
      ? "A combined goods total must have a separate packaging amount of zero; its split is unknown."
      : "Included packaging must have a separate packaging amount of zero." });
  }
  if (value.packagingTreatment !== "separate" && value.adjustments?.some(row => row.destination === "packaging" && row.amountMills !== 0))
    context.addIssue({ code: "custom", path: ["adjustments"], message: "Packaging included in product cannot also receive a separate packaging adjustment." });
}

/** Explicit invoice composition; approval and inventory application are separate evidence. */
export const invoiceCostComponentEvidenceSchema = z.object({
  contractVersion: z.literal(1),
  ...invoiceCostComponentFields,
  source: z.enum(["purchase_order_import", "operator_review"]),
}).strict().superRefine(validateInvoiceCostPackaging);

export type InvoiceCostComponentEvidence = z.infer<typeof invoiceCostComponentEvidenceSchema>;

/** Goods excludes tax: a goods credit cannot refund capitalized tax.
 * For a combined bill, the existing product valuation bucket carries the whole
 * goods amount. The explicit combined basis means its packaging split is unknown;
 * zero in the separate packaging bucket never asserts that packaging was free. */
export function invoiceGoodsAmounts(evidence: InvoiceCostComponentEvidence) {
  const adjustment = invoiceAdjustmentAmounts(evidence.adjustments);
  const productMills = readIntegerMills(BigInt(evidence.productMills) + BigInt(adjustment.productMills), "net product amount", true);
  const packagingMills = readIntegerMills(BigInt(evidence.packagingMills) + BigInt(adjustment.packagingMills), "net packaging amount", true);
  if (productMills < 0 || packagingMills < 0) throw new RangeError("Billed adjustments exceed their product or packaging amount.");
  return { productMills, packagingMills, adjustmentMills: adjustment.totalMills };
}
