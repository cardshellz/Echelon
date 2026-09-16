import { describe, expect, it } from "vitest";
import {
  deriveChannelFulfillmentQuantityAuthority,
  type ChannelFulfillmentQuantityEvidence,
} from "../../channel-fulfillment-quantity-authority";
import { evaluateChannelFulfillmentWritebackPolicy } from "../../channel-fulfillment-authority.policy";

const evidence = (overrides: Partial<ChannelFulfillmentQuantityEvidence> = {}): ChannelFulfillmentQuantityEvidence => ({
  lifetimePaidQuantity: 2,
  paidQuantity: 2,
  channelRemainingQuantity: 1,
  cancelledQuantity: 0,
  refundedQuantity: 0,
  refundCancelQuantity: 0,
  refundOtherQuantity: 0,
  ...overrides,
});

describe("cumulative channel fulfillment quantity authority", () => {
  it.each([0, 1, 2])("does not count %s remaining as cancellations or reduce the cumulative cap", (remaining) => {
    const result = deriveChannelFulfillmentQuantityAuthority(evidence({ channelRemainingQuantity: remaining }));
    expect(result).toMatchObject({ commercialAuthorizedQuantity: 2, quantityCancelled: 0 });
    expect(evaluateChannelFulfillmentWritebackPolicy({
      channelProvider: "shopify", lineFulfillmentProvider: "shopify",
      omsOrderStatus: "open", omsFinancialStatus: "paid",
      requiresReview: false, reviewReason: null,
      commercialAuthorizedQuantity: result.commercialAuthorizedQuantity,
      cumulativePhysicalQuantity: 2,
    }).allowed).toBe(true);
  });

  it.each([
    ["cancelled", { cancelledQuantity: 1 }],
    ["refunded", { refundedQuantity: 1, refundOtherQuantity: 1 }],
    ["cancelled and refunded with overlapping cancel disposition", {
      cancelledQuantity: 1, refundedQuantity: 1, refundCancelQuantity: 1,
    }],
    ["reduced current paid quantity", { paidQuantity: 1 }],
  ] as const)("retains the cap for %s units", (_name, overrides) => {
    expect(deriveChannelFulfillmentQuantityAuthority(evidence(overrides))).toMatchObject({
      commercialAuthorizedQuantity: 1, quantityCancelled: 1,
    });
  });

  it("does not consume two backordered cases while recognizing six shipped cases", () => {
    expect(deriveChannelFulfillmentQuantityAuthority(evidence({
      lifetimePaidQuantity: 8, paidQuantity: 8, channelRemainingQuantity: 5,
    }))).toMatchObject({ commercialAuthorizedQuantity: 8, quantityCancelled: 0 });
  });

  it("retains independent cancellations and non-cancel refunds", () => {
    expect(deriveChannelFulfillmentQuantityAuthority(evidence({
      lifetimePaidQuantity: 10, paidQuantity: 10, channelRemainingQuantity: 0,
      cancelledQuantity: 2, refundedQuantity: 5, refundCancelQuantity: 2, refundOtherQuantity: 3,
    }))).toMatchObject({ commercialAuthorizedQuantity: 5, quantityCancelled: 5 });
  });

  it.each([
    { refundedQuantity: 1 }, { refundOtherQuantity: 1 },
    { cancelledQuantity: 3 }, { paidQuantity: 3 }, { channelRemainingQuantity: 3 },
    { paidQuantity: null }, { paidQuantity: "2" }, { cancelledQuantity: undefined },
    { paidQuantity: NaN }, { paidQuantity: Infinity }, { refundedQuantity: -1 },
    { refundedQuantity: 0.5 }, { lifetimePaidQuantity: 2_147_483_648 },
  ])("rejects missing, inconsistent, or invalid evidence: %j", (overrides) => {
    expect(() => deriveChannelFulfillmentQuantityAuthority(
      evidence(overrides as Partial<ChannelFulfillmentQuantityEvidence>),
    )).toThrow(expect.objectContaining({ code: "INVALID_CHANNEL_FULFILLMENT_QUANTITY_AUTHORITY" }));
  });

  it("supports zero and maximum database quantities without mutating its input", () => {
    for (const count of [0, 2_147_483_647]) {
      const raw = Object.freeze(evidence({ lifetimePaidQuantity: count, paidQuantity: count, channelRemainingQuantity: 0 }));
      const result = deriveChannelFulfillmentQuantityAuthority(raw);
      expect(result.commercialAuthorizedQuantity).toBe(count);
      expect(result.quantityCancelled).toBe(0);
      expect(Object.isFrozen(result)).toBe(true);
      expect(raw).not.toHaveProperty("commercialAuthorizedQuantity");
    }
  });
});
