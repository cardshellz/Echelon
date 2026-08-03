import { describe, expect, it } from "vitest";
import { resolveVariantAvailabilityTarget } from "../../variant-availability-sync.domain";

const ELIGIBLE_INPUT = {
  desiredActive: true,
  catalogVariantActive: true,
  catalogProductActive: true,
  catalogProductStatus: "active",
  productExcluded: false,
  variantExcluded: false,
  productOverrideIsListed: 1,
  variantOverrideIsListed: 1,
  allocatedQuantity: 27,
} as const;

describe("resolveVariantAvailabilityTarget", () => {
  it("forces an inactive variant to zero without changing its stored allocation", () => {
    expect(resolveVariantAvailabilityTarget({
      ...ELIGIBLE_INPUT,
      desiredActive: false,
      catalogVariantActive: false,
      allocatedQuantity: 225,
    })).toEqual({
      feedActive: false,
      channelEligible: false,
      quantity: 0,
    });
  });

  it("restores the allocation when the variant is active and channel-eligible", () => {
    expect(resolveVariantAvailabilityTarget(ELIGIBLE_INPUT)).toEqual({
      feedActive: true,
      channelEligible: true,
      quantity: 27,
    });
  });

  it.each([
    ["inactive product", { catalogProductActive: false }],
    ["archived product", { catalogProductStatus: "archived" }],
    ["product exclusion", { productExcluded: true }],
    ["variant exclusion", { variantExcluded: true }],
    ["product override", { productOverrideIsListed: 0 }],
    ["variant override", { variantOverrideIsListed: 0 }],
  ])("keeps the active feed mapped but pushes zero for %s", (_label, override) => {
    expect(resolveVariantAvailabilityTarget({
      ...ELIGIBLE_INPUT,
      ...override,
    })).toEqual({
      feedActive: true,
      channelEligible: false,
      quantity: 0,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid allocated quantity %s",
    (allocatedQuantity) => {
      expect(() => resolveVariantAvailabilityTarget({
        ...ELIGIBLE_INPUT,
        allocatedQuantity,
      })).toThrow("allocatedQuantity must be a non-negative safe integer");
    },
  );
});
