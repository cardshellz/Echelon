import { describe, expect, it } from "vitest";
import { resolveRulePricing } from "../pricing-programs/DestinationProductPolicies";

const EMPTY_PRICING = {
  rateUsd: "",
  perPoundUsd: "",
  thresholdUsd: "",
  bands: [],
};

describe("shipping product-rule form pricing", () => {
  it("builds a price-free restriction even when the hidden behavior defaults to fixed", () => {
    expect(resolveRulePricing("restriction", "fixed", EMPTY_PRICING)).toEqual({
      ok: true,
      rateCents: null,
      perStartedPoundCents: null,
      thresholdCents: null,
      bands: [],
    });
  });

  it("still requires an amount for a fixed-charge exception", () => {
    expect(resolveRulePricing("exception", "fixed", EMPTY_PRICING)).toEqual({
      ok: false,
      message: "Enter a valid shipping amount.",
    });
  });
});
