import { z } from "zod";

const policyId = z.string().trim().min(1).max(100).nullable();

/** Display-only saved state. This contract cannot attest to current eBay access. */
export const ebaySavedListingPoliciesSchema = z.object({
  storeConnectionId: z.number().int().positive().safe(),
  verification: z.literal("not_checked"),
  defaults: z.object({ fulfillmentPolicyId: policyId, returnPolicyId: policyId, paymentPolicyId: policyId }),
  assignments: z.array(z.object({
    productVariantId: z.number().int().positive().safe(),
    revisionId: z.number().int().positive().safe(),
    fulfillmentPolicyId: policyId,
    returnPolicyId: policyId,
    paymentPolicyId: policyId,
    updatedAt: z.string().datetime(),
  })).superRefine((rows, context) => {
    const seen = new Set<number>();
    rows.forEach((row, index) => {
      if (seen.has(row.productVariantId)) context.addIssue({ code: z.ZodIssueCode.custom,
        path: [index, "productVariantId"], message: "Duplicate saved listing assignment." });
      seen.add(row.productVariantId);
    });
  }),
  fetchedAt: z.string().datetime(),
});

export type EbaySavedListingPolicies = z.infer<typeof ebaySavedListingPoliciesSchema>;
