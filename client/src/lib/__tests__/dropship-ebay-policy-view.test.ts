import { describe, expect, it } from "vitest";
import {
  hasEbayPolicyEditorChange,
  paginateEbayPolicyRows,
  singleEbayListingPolicyPatch,
  summarizeEbayListingPolicy,
} from "../dropship-ebay-policy-view";
import type { DropshipEbayListingPolicyOverrideResponse } from "../dropship-ops-surface";

const data: DropshipEbayListingPolicyOverrideResponse = {
  storeConnectionId: 1,
  defaults: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" },
  assignments: [],
  fetchedAt: "2026-09-05T12:00:00.000Z",
  options: {
    fulfillmentPolicies: [
      { id: "ground", name: "Ground Advantage", compatible: true, compatibilityIssues: [] },
      { id: "air", name: "Overnight", compatible: false, compatibilityIssues: [] },
    ],
    returnPolicies: [{ id: "returns", name: "30 day returns" }],
    paymentPolicies: [{ id: "payments", name: "Managed payments" }],
  },
};
const assignment = {
  productVariantId: 22,
  revisionId: 5,
  fulfillmentPolicyId: "ground",
  returnPolicyId: null,
  paymentPolicyId: null,
  updatedAt: data.fetchedAt,
};

describe("eBay policy compact view", () => {
  it("limits a 10,000-row view to 50 rows without changing its input", () => {
    const rows = Array.from({ length: 10000 }, (_, index) => index + 1);
    const result = paginateEbayPolicyRows(rows, 2);
    expect(result).toMatchObject({ page: 2, pageCount: 200, total: 10000, start: 51, end: 100 });
    expect(result.rows).toEqual(rows.slice(50, 100));
    expect(result.rows).toHaveLength(50);
    expect(rows).toHaveLength(10000);
    expect(rows[0]).toBe(1);
  });

  it("clamps the page after filtering or selection removal and handles empty results", () => {
    expect(paginateEbayPolicyRows([1, 2], 20)).toMatchObject({ page: 1, pageCount: 1, start: 1, end: 2, rows: [1, 2] });
    expect(paginateEbayPolicyRows([], 20)).toEqual({ page: 1, pageCount: 1, total: 0, start: 0, end: 0, rows: [] });
    expect(paginateEbayPolicyRows(Array.from({ length: 51 }, (_, index) => index), 2)).toMatchObject({ start: 51, end: 51, rows: [50] });
  });

  it.each([0, -1, NaN, Infinity, 1.5])("normalizes invalid requested page %s", (page) => {
    expect(paginateEbayPolicyRows([1], page).page).toBe(1);
  });

  it("initializes a single editor from overrides without copying effective defaults", () => {
    expect(singleEbayListingPolicyPatch(assignment)).toEqual({ fulfillmentPolicyId: "ground", returnPolicyId: null, paymentPolicyId: null });
    expect(singleEbayListingPolicyPatch(undefined)).toEqual({ fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null });
    expect(assignment.revisionId).toBe(5);
  });

  it("enables a single save only for deliberate changes but retains bulk patch semantics", () => {
    const initial = singleEbayListingPolicyPatch(assignment);
    expect(hasEbayPolicyEditorChange(initial, initial)).toBe(false);
    expect(hasEbayPolicyEditorChange({ ...initial, fulfillmentPolicyId: null }, initial)).toBe(true);
    expect(hasEbayPolicyEditorChange({}, null)).toBe(false);
    expect(hasEbayPolicyEditorChange({ returnPolicyId: null }, null)).toBe(true);
    expect(hasEbayPolicyEditorChange({ returnPolicyId: undefined }, null)).toBe(false);
  });

  it("shows effective policy names with inheritance independently for each field", () => {
    expect(summarizeEbayListingPolicy(data, assignment, "fulfillmentPolicyId")).toEqual({ name: "Ground Advantage", source: "Override", needsAttention: false });
    expect(summarizeEbayListingPolicy(data, assignment, "returnPolicyId")).toEqual({ name: "30 day returns", source: "Store default", needsAttention: false });
    expect(summarizeEbayListingPolicy(data, undefined, "paymentPolicyId")).toEqual({ name: "Managed payments", source: "Store default", needsAttention: false });
  });

  it("distinguishes missing, unavailable, and incompatible policies", () => {
    expect(summarizeEbayListingPolicy({ ...data, defaults: { ...data.defaults, paymentPolicyId: null } }, undefined, "paymentPolicyId"))
      .toEqual({ name: "Not configured", source: "Store default", needsAttention: true });
    expect(summarizeEbayListingPolicy(data, { ...assignment, fulfillmentPolicyId: "deleted" }, "fulfillmentPolicyId"))
      .toEqual({ name: "Unavailable policy (deleted)", source: "Override", needsAttention: true });
    expect(summarizeEbayListingPolicy(data, { ...assignment, fulfillmentPolicyId: "air" }, "fulfillmentPolicyId"))
      .toEqual({ name: "Overnight", source: "Override", needsAttention: true });
  });
});
