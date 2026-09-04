import type { DropshipEbayListingPolicyOverride, DropshipEbayListingPolicyOverrideResponse } from "./dropship-ops-surface";
import { MAX_EBAY_POLICY_BULK_ASSIGNMENTS } from "@shared/dropship-ebay-policy-limits";

export const EBAY_POLICY_FIELDS = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const;
export type EbayPolicyField = typeof EBAY_POLICY_FIELDS[number];
export type EbayPolicyPatch = Partial<Record<EbayPolicyField, string | null>>;
export type EbayBulkPolicyAssignment = Record<EbayPolicyField, string | null> & {
  productVariantId: number;
  expectedRevisionId: number | null;
};
export const INHERIT_POLICY_VALUE = "__store_default__";
export const UNCHANGED_POLICY_VALUE = "__unchanged__";

export function effectiveEbayPolicies(
  assignment: DropshipEbayListingPolicyOverride | null | undefined,
  defaults: DropshipEbayListingPolicyOverrideResponse["defaults"],
): Record<EbayPolicyField, string | null> {
  return {
    fulfillmentPolicyId: assignment?.fulfillmentPolicyId ?? defaults.fulfillmentPolicyId,
    returnPolicyId: assignment?.returnPolicyId ?? defaults.returnPolicyId,
    paymentPolicyId: assignment?.paymentPolicyId ?? defaults.paymentPolicyId,
  };
}

/** A null patch explicitly inherits; an omitted field preserves that row's choice. */
export function buildEbayBulkPolicyAssignments(input: {
  productVariantIds: readonly number[];
  assignments: readonly DropshipEbayListingPolicyOverride[];
  patch: EbayPolicyPatch;
}): EbayBulkPolicyAssignment[] {
  if (!EBAY_POLICY_FIELDS.some((field) => input.patch[field] !== undefined)) {
    throw new Error("Choose at least one policy field to change.");
  }
  const ids = [...new Set(input.productVariantIds)].sort((left, right) => left - right);
  if (ids.length === 0 || ids.length > MAX_EBAY_POLICY_BULK_ASSIGNMENTS
    || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`Select between 1 and ${MAX_EBAY_POLICY_BULK_ASSIGNMENTS} listings.`);
  }
  const assignments = new Map(input.assignments.map((assignment) => [assignment.productVariantId, assignment]));
  return ids.map((productVariantId) => {
    const current = assignments.get(productVariantId);
    return {
      productVariantId,
      expectedRevisionId: current?.revisionId ?? null,
      fulfillmentPolicyId: input.patch.fulfillmentPolicyId !== undefined ? input.patch.fulfillmentPolicyId : current?.fulfillmentPolicyId ?? null,
      returnPolicyId: input.patch.returnPolicyId !== undefined ? input.patch.returnPolicyId : current?.returnPolicyId ?? null,
      paymentPolicyId: input.patch.paymentPolicyId !== undefined ? input.patch.paymentPolicyId : current?.paymentPolicyId ?? null,
    };
  });
}

export function ebayPolicyDisplayOptions(data: DropshipEbayListingPolicyOverrideResponse, field: EbayPolicyField) {
  if (field === "fulfillmentPolicyId") return data.options.fulfillmentPolicies.map((option) => ({
    ...option,
    disabled: !option.compatible,
    description: option.compatible ? "Compatible with Card Shellz fulfillment" : option.compatibilityIssues[0]?.message ?? "Not compatible",
  }));
  return field === "returnPolicyId" ? data.options.returnPolicies : data.options.paymentPolicies;
}

export const EBAY_POLICY_LABELS: Record<EbayPolicyField, string> = {
  fulfillmentPolicyId: "Fulfillment policy", returnPolicyId: "Return policy", paymentPolicyId: "Payment policy",
};
