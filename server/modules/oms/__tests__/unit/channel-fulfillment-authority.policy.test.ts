import { describe, expect, it } from "vitest";

import {
  evaluateChannelFulfillmentWritebackPolicy,
  type ChannelFulfillmentWritebackPolicyInput,
} from "../../channel-fulfillment-authority.policy";

function input(
  overrides: Partial<ChannelFulfillmentWritebackPolicyInput> = {},
): ChannelFulfillmentWritebackPolicyInput {
  return {
    channelProvider: "shopify",
    lineFulfillmentProvider: "shopify",
    omsOrderStatus: "confirmed",
    omsFinancialStatus: "paid",
    requiresReview: false,
    reviewReason: null,
    commercialAuthorizedQuantity: 2,
    cumulativePhysicalQuantity: 2,
    ...overrides,
  };
}

describe("channel fulfillment writeback authority policy", () => {
  it("allows exact cumulative physical quantity within current authority", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input())).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("blocks a package that exceeds authority reduced by cancellation or refund", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      commercialAuthorizedQuantity: 1,
      cumulativePhysicalQuantity: 2,
    }))).toEqual({
      allowed: false,
      reasons: ["physical_quantity_exceeds_current_authority"],
    });
  });

  it.each([
    ["cancelled", "paid", "terminal_commercial_order"],
    ["refunded", "refunded", "terminal_commercial_order"],
    ["confirmed", "voided", "terminal_financial_order"],
  ] as const)(
    "blocks terminal commercial state status=%s financial=%s",
    (omsOrderStatus, omsFinancialStatus, expectedReason) => {
      const decision = evaluateChannelFulfillmentWritebackPolicy(input({
        omsOrderStatus,
        omsFinancialStatus,
      }));

      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain(expectedReason);
    },
  );

  it("blocks a line owned by another fulfillment provider", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      lineFulfillmentProvider: "dropship_vendor",
    }))).toEqual({
      allowed: false,
      reasons: ["fulfillment_provider_mismatch"],
    });
  });

  it("blocks a classified shipment review without treating unrelated review as authority loss", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      requiresReview: true,
      reviewReason: "shipstation_shipped_after_cancel",
    })).reasons).toContain("blocking_review");

    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      requiresReview: true,
      reviewReason: "carrier_name_needs_normalization",
    })).allowed).toBe(true);
  });

  it("returns immutable audit evidence", () => {
    const decision = evaluateChannelFulfillmentWritebackPolicy(input());

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
  });

  it("reevaluates a stale computed quantity review but does not bypass a real excess", () => {
    const reviewed = input({
      requiresReview: true,
      reviewReason: "physical_shipment_exceeds_current_line_authority",
    });
    expect(evaluateChannelFulfillmentWritebackPolicy(reviewed).allowed).toBe(true);
    expect(evaluateChannelFulfillmentWritebackPolicy({
      ...reviewed, cumulativePhysicalQuantity: 3,
    })).toEqual({ allowed: false, reasons: ["physical_quantity_exceeds_current_authority"] });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed on invalid quantity %s", (value) => {
      expect(evaluateChannelFulfillmentWritebackPolicy(input({
        commercialAuthorizedQuantity: value,
      })).reasons).toContain("invalid_quantity_authority");
      expect(evaluateChannelFulfillmentWritebackPolicy(input({
        cumulativePhysicalQuantity: value,
      })).reasons).toContain("invalid_quantity_authority");
    },
  );
});
