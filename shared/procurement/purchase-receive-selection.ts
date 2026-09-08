import { z } from "zod";

const pgId = z.number().int().positive().max(2_147_483_647);

/** The catalog hierarchy is evidence for an unattended choice only when its
 * highest active level has exactly one variant. A tie never establishes a default. */
export const purchaseReceiveSelectionSchema = z.object({
  version: z.literal(1),
  highestHierarchyLevel: z.number().int().nullable(),
  candidateCount: z.number().int().nonnegative().max(2_147_483_647),
  selectedVariantId: pgId.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.candidateCount === 0) !== (value.highestHierarchyLevel === null)
    || (value.candidateCount === 1) !== (value.selectedVariantId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Receive selection must contain an identity only for one highest active variant" });
  }
});

export type PurchaseReceiveSelection = z.infer<typeof purchaseReceiveSelectionSchema>;

/** Missing evidence remains readable history, but cannot authorize new
 * unattended work. Do not reconstruct a past choice from today's catalog. */
export function hasVerifiedUniqueReceiveSelection(evidence: unknown, variantId: number | null | undefined): boolean {
  const parsed = purchaseReceiveSelectionSchema.safeParse(evidence);
  return parsed.success && parsed.data.candidateCount === 1 && parsed.data.selectedVariantId === variantId;
}
