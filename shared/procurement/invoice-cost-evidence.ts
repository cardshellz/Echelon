import { z } from "zod";

export const invoiceCostComponentFields = {
  packagingTreatment: z.enum(["separate", "included_in_product"]),
  productMills: z.number().int().nonnegative().safe(),
  packagingMills: z.number().int().nonnegative().safe(),
  adjustmentMills: z.number().int().safe(),
};

export function validateInvoiceCostPackaging(
  value: { packagingTreatment: string; packagingMills: number }, context: z.RefinementCtx,
): void {
  if (value.packagingTreatment === "included_in_product" && value.packagingMills !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["packagingMills"], message: "Included packaging must have a separate packaging amount of zero." });
  }
}

/** Explicit invoice composition; approval and inventory application are separate evidence. */
export const invoiceCostComponentEvidenceSchema = z.object({
  contractVersion: z.literal(1),
  ...invoiceCostComponentFields,
  source: z.enum(["purchase_order_import", "operator_review"]),
}).strict().superRefine(validateInvoiceCostPackaging);

export type InvoiceCostComponentEvidence = z.infer<typeof invoiceCostComponentEvidenceSchema>;
