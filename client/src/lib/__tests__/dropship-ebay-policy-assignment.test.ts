import { describe, expect, it } from "vitest";
import { buildEbayBulkPolicyAssignments, effectiveEbayPolicies, ebayPolicyDisplayOptions } from "../dropship-ebay-policy-assignment";
import type { DropshipEbayListingPolicyOverride, DropshipEbayListingPolicyOverrideResponse } from "../dropship-ops-surface";

const assignment: DropshipEbayListingPolicyOverride = {
  productVariantId: 501,
  revisionId: 9,
  fulfillmentPolicyId: "usps-policy",
  returnPolicyId: "no-returns",
  paymentPolicyId: null,
  updatedAt: "2026-09-04T12:00:00.000Z",
};
const defaults = { fulfillmentPolicyId: "ups-policy", returnPolicyId: "returns-default", paymentPolicyId: "managed-payments" };

describe("eBay listing policy assignment model", () => {
  it("resolves each policy independently against the store default", () => {
    expect(effectiveEbayPolicies(assignment, defaults)).toEqual({
      fulfillmentPolicyId: "usps-policy", returnPolicyId: "no-returns", paymentPolicyId: "managed-payments",
    });
    expect(effectiveEbayPolicies(null, defaults)).toEqual(defaults);
    expect(effectiveEbayPolicies(assignment, { ...defaults, paymentPolicyId: null }).paymentPolicyId).toBeNull();
  });

  it("preserves unrelated choices, snapshots revisions, sorts and deduplicates without mutation", () => {
    const input = { productVariantIds: [502, 501, 502], assignments: [assignment], patch: { fulfillmentPolicyId: "ups-policy" } };
    const original = structuredClone(input);
    expect(buildEbayBulkPolicyAssignments(input)).toEqual([
      { productVariantId: 501, expectedRevisionId: 9, fulfillmentPolicyId: "ups-policy", returnPolicyId: "no-returns", paymentPolicyId: null },
      { productVariantId: 502, expectedRevisionId: null, fulfillmentPolicyId: "ups-policy", returnPolicyId: null, paymentPolicyId: null },
    ]);
    expect(input).toEqual(original);
  });

  it("treats null as explicit inheritance and omitted fields as leave unchanged", () => {
    expect(buildEbayBulkPolicyAssignments({ productVariantIds: [501], assignments: [assignment],
      patch: { fulfillmentPolicyId: null, returnPolicyId: undefined } })[0]).toEqual({
      productVariantId: 501, expectedRevisionId: 9, fulfillmentPolicyId: null, returnPolicyId: "no-returns", paymentPolicyId: null,
    });
  });

  it("can reset all three fields to defaults", () => {
    expect(buildEbayBulkPolicyAssignments({ productVariantIds: [501], assignments: [assignment],
      patch: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null } })[0]).toMatchObject({
      fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    });
  });

  it.each([[], [0], [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 501 }, (_, index) => index + 1)].map((productVariantIds) => ({ productVariantIds })))(
    "rejects invalid or oversized targets ($productVariantIds)", ({ productVariantIds }) => {
      expect(() => buildEbayBulkPolicyAssignments({ productVariantIds, assignments: [], patch: { returnPolicyId: null } })).toThrow();
    },
  );

  it("requires a deliberate field choice and accepts 500 rows", () => {
    expect(() => buildEbayBulkPolicyAssignments({ productVariantIds: [501], assignments: [], patch: {} })).toThrow("Choose at least one");
    expect(buildEbayBulkPolicyAssignments({ productVariantIds: Array.from({ length: 500 }, (_, index) => index + 1),
      assignments: [], patch: { returnPolicyId: null } })).toHaveLength(500);
  });

  it("keeps incompatible fulfillment policies visible but disabled and does not disable payment or returns", () => {
    const data: DropshipEbayListingPolicyOverrideResponse = {
      storeConnectionId: 44, defaults, assignments: [assignment], fetchedAt: "2026-09-04T12:00:00.000Z",
      options: {
        fulfillmentPolicies: [
          { id: "usps-policy", name: "Ground Advantage", compatible: true, compatibilityIssues: [] },
          { id: "overnight", name: "Overnight", compatible: false, compatibilityIssues: [{ code: "shipping_service_unsupported:Overnight", message: "Not offered by Card Shellz." }] },
        ],
        returnPolicies: [{ id: "no-returns", name: "No returns" }],
        paymentPolicies: [{ id: "managed-payments", name: "Managed payments" }],
      },
    };
    expect(ebayPolicyDisplayOptions(data, "fulfillmentPolicyId")).toMatchObject([
      { id: "usps-policy", disabled: false }, { id: "overnight", disabled: true, description: "Not offered by Card Shellz." },
    ]);
    expect(ebayPolicyDisplayOptions(data, "returnPolicyId")).toEqual(data.options.returnPolicies);
    expect(ebayPolicyDisplayOptions(data, "paymentPolicyId")).toEqual(data.options.paymentPolicies);
  });
});
