import { describe, expect, it } from "vitest";
import { shouldRepairInternalOnlyChannelStock } from "../../listing-member-lifecycle";

describe("shared channel member availability decisions", () => {
  const activeInternal = { productActive: true,variantActive: true,productStatus: "active",
    salesEligibility: "internal_only",availableQuantity: 3 };
  it("retains the existing repair for a positively identified active internal-only variant", () => {
    expect(shouldRepairInternalOnlyChannelStock(activeInternal)).toBe(true);
  });
  it.each([
    { productActive: false }, { variantActive: false }, { productStatus: "archived" },
    { productActive: null }, { variantActive: null }, { salesEligibility: "sellable" },
    { availableQuantity: 0 }, { availableQuantity: null }, { availableQuantity: Number.NaN },
  ])("does not schedule stock repair from archived, unknown or inapplicable evidence: %o", changes => {
    expect(shouldRepairInternalOnlyChannelStock({ ...activeInternal,...changes })).toBe(false);
  });
});
