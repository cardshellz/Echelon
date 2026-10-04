import { describe, expect, it } from "vitest";

import {
  DROPSHIP_WRITEBACK_PROVIDER,
  evaluateChannelFulfillmentWritebackPolicy,
  resolveChannelWritebackProvider,
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

  it("allows an exact commercial subset without changing physical package quantity", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      commercialAuthorizedQuantity: 1,
      cumulativePhysicalQuantity: 2,
      cumulativeCommercialQuantity: 1,
    }))).toEqual({ allowed: true, reasons: [] });
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      commercialAuthorizedQuantity: 1,
      cumulativePhysicalQuantity: 2,
      cumulativeCommercialQuantity: 2,
    }))).toEqual({
      allowed: false,
      reasons: ["commercial_quantity_exceeds_current_authority"],
    });
  });

  it("rejects commercial quantity without matching physical evidence", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      cumulativePhysicalQuantity: 2,
      cumulativeCommercialQuantity: 3,
    })).reasons).toContain("invalid_quantity_authority");
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

describe("channel writeback provider resolution", () => {
  it("routes a dropship line on the internal Dropship channel to the vendor's store", () => {
    expect(resolveChannelWritebackProvider({
      channelProvider: "manual",
      lineFulfillmentProvider: "dropship",
    })).toBe(DROPSHIP_WRITEBACK_PROVIDER);
    expect(resolveChannelWritebackProvider({
      channelProvider: " MANUAL ",
      lineFulfillmentProvider: " Dropship ",
    })).toBe("dropship");
  });

  it("keeps the order's channel for every other line", () => {
    const cases: Array<[string | null, string | null, string | null]> = [
      ["manual", "manual", "manual"],
      ["manual", null, "manual"],
      ["manual", "", "manual"],
      ["shopify", "shopify", "shopify"],
      ["ebay", "ebay", "ebay"],
      // Only the internal Dropship channel is rerouted. A dropship line on a
      // real sales channel keeps that channel and stays a provider mismatch.
      ["shopify", "dropship", "shopify"],
      ["ebay", "dropship", "ebay"],
      [" EBAY ", null, "ebay"],
    ];
    for (const [channelProvider, lineFulfillmentProvider, expected] of cases) {
      expect(resolveChannelWritebackProvider({ channelProvider, lineFulfillmentProvider }))
        .toBe(expected);
    }
  });

  it("never invents a destination for an order without a channel provider", () => {
    expect(resolveChannelWritebackProvider({ channelProvider: null, lineFulfillmentProvider: "dropship" }))
      .toBeNull();
    expect(resolveChannelWritebackProvider({ channelProvider: "  ", lineFulfillmentProvider: "dropship" }))
      .toBeNull();
  });

  it("lets the writeback policy allow a dropship line once it is routed to the vendor's store", () => {
    // Before routing, the line was a provider mismatch against the 'manual' channel.
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      channelProvider: "manual",
      lineFulfillmentProvider: "dropship",
    })).reasons).toEqual(["fulfillment_provider_mismatch"]);

    const channelProvider = resolveChannelWritebackProvider({
      channelProvider: "manual",
      lineFulfillmentProvider: "dropship",
    });
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      channelProvider: channelProvider!,
      lineFulfillmentProvider: "dropship",
    }))).toEqual({ allowed: true, reasons: [] });
  });

  it("still blocks a routed dropship line on a cancelled or refunded order", () => {
    expect(evaluateChannelFulfillmentWritebackPolicy(input({
      channelProvider: DROPSHIP_WRITEBACK_PROVIDER,
      lineFulfillmentProvider: "dropship",
      omsOrderStatus: "cancelled",
      omsFinancialStatus: "refunded",
    })).reasons).toEqual(["terminal_commercial_order", "terminal_financial_order"]);
  });
});
