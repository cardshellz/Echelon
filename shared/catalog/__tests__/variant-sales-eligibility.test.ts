import { describe, expect, it } from "vitest";

import {
  isCustomerSellableVariant,
  type VariantSalesEligibility,
} from "../variant-sales-eligibility";

describe("variant sales eligibility", () => {
  it("allows the explicit sellable identity and historical missing values", () => {
    expect(isCustomerSellableVariant({ salesEligibility: "sellable" })).toBe(true);
    expect(isCustomerSellableVariant({})).toBe(true);
    expect(isCustomerSellableVariant({ salesEligibility: null })).toBe(true);
  });

  it("rejects internal-only variants without changing inventory identity", () => {
    expect(isCustomerSellableVariant({ salesEligibility: "internal_only" })).toBe(false);
  });

  it("fails closed for malformed values from an untyped boundary", () => {
    expect(isCustomerSellableVariant({
      salesEligibility: "malformed" as unknown as VariantSalesEligibility,
    })).toBe(false);
  });
});
