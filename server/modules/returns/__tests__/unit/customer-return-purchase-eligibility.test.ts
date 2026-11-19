import { describe, expect, it } from "vitest";
import { evaluatePurchasedCustomerReturnEligibility } from "../../domain/customer-return-eligibility";

function facts(quantity = 4, claimed = 0) {
  return {
    now: "2026-10-01T12:00:00.000Z",
    policy: { channelId: 36, version: 1, returnWindowDays: 365 },
    order: {
      orderId: "gid://shopify/Order/1000",
      channelId: 36,
      provider: "shopify",
      destinationCountryCode: "US",
      purchasedAt: "2026-09-01T12:00:00.000Z",
      lines: [
        {
          lineId: "gid://shopify/LineItem/500",
          sku: "SAME",
          requiresShipping: true,
          purchasedQuantity: quantity,
          allocations: [],
          claims:
            claimed > 0
              ? [{ claimId: "return:1", allocationId: null, quantity: claimed }]
              : [],
        },
      ],
    },
  };
}

describe("purchased Shopify return entitlement", () => {
  it("requires no fulfillment, delivery or outbound warehouse identity", () => {
    const input = facts();
    const before = structuredClone(input);
    expect(
      evaluatePurchasedCustomerReturnEligibility(input).lines[0],
    ).toMatchObject({
      eligibleQuantity: 4,
      deliveredQuantity: 0,
      claimedQuantity: 0,
      allocations: [],
    });
    expect(input).toEqual(before);
  });
  it.each([
    [0, 0, 0],
    [4, 1, 3],
    [4, 4, 0],
    [2147483647, 1, 2147483646],
  ])(
    "conserves purchased units %s less actual return claims %s",
    (quantity, claimed, remaining) => {
      expect(
        evaluatePurchasedCustomerReturnEligibility(facts(quantity, claimed))
          .lines[0].eligibleQuantity,
      ).toBe(remaining);
    },
  );
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid purchased quantity %s",
    (quantity) => {
      expect(() =>
        evaluatePurchasedCustomerReturnEligibility(facts(quantity)),
      ).toThrow();
    },
  );
  it("rejects excess physical claims instead of silently granting units", () => {
    expect(() =>
      evaluatePurchasedCustomerReturnEligibility(facts(4, 5)),
    ).toThrow();
  });
  it("keeps same-SKU purchased lines separate", () => {
    const input = facts(4, 3);
    input.order.lines.push({
      ...input.order.lines[0],
      lineId: "gid://shopify/LineItem/501",
      claims: [],
    });
    expect(
      evaluatePurchasedCustomerReturnEligibility(input).lines.map(
        (line) => line.eligibleQuantity,
      ),
    ).toEqual([1, 4]);
  });
  it.each(["foreign", "nonphysical", "expired", "wrong-channel"])(
    "preserves the existing %s policy",
    (change) => {
      const input = facts();
      if (change === "foreign") input.order.destinationCountryCode = "CA";
      if (change === "nonphysical")
        input.order.lines[0].requiresShipping = false;
      if (change === "expired")
        input.order.purchasedAt = "2024-01-01T00:00:00.000Z";
      if (change === "wrong-channel") input.order.channelId = 37;
      expect(
        evaluatePurchasedCustomerReturnEligibility(input).eligibleQuantity,
      ).toBe(0);
    },
  );
});
