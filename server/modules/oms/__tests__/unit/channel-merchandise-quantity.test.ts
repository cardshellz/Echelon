import { describe, expect, it } from "vitest";
import { observeChannelMerchandiseQuantity } from "../../domain/channel-merchandise-quantity";
import { isMerchandiseOrderCancelled } from "../../domain/order-merchandise-state";
import { deriveOmsLineAuthority } from "../../oms-line-authority";

const VERSION = "2026-10-24T12:00:00.000Z";

describe("channel merchandise independently of financial settlement", () => {
  it.each(["paid", "partially_refunded", "refunded", "voided", "pending"])(
    "%s does not itself cancel an order",
    (financialStatus) => {
      expect(
        isMerchandiseOrderCancelled({
          status: "confirmed",
          financialStatus,
        } as { status: string }),
      ).toBe(false);
    },
  );
  it("recognizes an explicit channel order cancellation", () => {
    expect(isMerchandiseOrderCancelled({ status: "cancelled" })).toBe(true);
    expect(
      isMerchandiseOrderCancelled({
        status: "confirmed",
        cancelledAt: VERSION,
      }),
    ).toBe(true);
  });
  it("keeps a missing commercial quantity unknown", () => {
    expect(observeChannelMerchandiseQuantity({ purchasedQuantity: 1 })).toEqual(
      {
        channelCurrentQuantity: null,
        channelQuantityUpdatedAt: null,
        stale: false,
      },
    );
  });
  it("records merchandise before payment without granting permission to dispatch it", () => {
    const state = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "pending",
      quantity: 2,
      currentQuantity: 2,
      fulfillableQuantity: 2,
      channelUpdatedAt: VERSION,
    });
    expect(state).toMatchObject({
      channelCurrentQuantity: 2,
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
    });
  });
  it("does not manufacture native version evidence from a legacy caller's processing clock", () => {
    const state = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "paid",
      quantity: 3,
      currentQuantity: 2,
      fulfillableQuantity: 2,
      now: new Date(VERSION),
      previous: {
        paidQuantity: 3,
        authorityFulfillableQuantity: 3,
        authorizationStatus: "authorized",
      },
    });
    expect(state.authorityFulfillableQuantity).toBe(2);
    expect(state.channelCurrentQuantity).toBeUndefined();
    expect(state.channelQuantityUpdatedAt).toBeUndefined();
    expect(() =>
      deriveOmsLineAuthority({
        sourceTopic: "orders/updated",
        quantity: 3,
        currentQuantity: 3,
        previous: {
          channelCurrentQuantity: 2,
          channelQuantityUpdatedAt: VERSION,
        },
      }),
    ).toThrow("undated observation");
  });
  it("does not use a later financial refund to subtract the same cancelled units again", () => {
    const state = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "partially_refunded",
      quantity: 3,
      currentQuantity: 2,
      fulfillableQuantity: 2,
      channelUpdatedAt: VERSION,
      previous: {
        paidQuantity: 3,
        authorityFulfillableQuantity: 2,
        refundedQuantity: 1,
        authorizationStatus: "partially_refunded",
      },
    });
    expect(state).toMatchObject({
      channelCurrentQuantity: 2,
      paidQuantity: 3,
      authorityFulfillableQuantity: 2,
    });
  });
  it("ignores an older observation without reducing paid authority or restoring removed units", () => {
    const state = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "paid",
      quantity: 1,
      currentQuantity: 1,
      fulfillableQuantity: 1,
      channelUpdatedAt: "2026-10-23T12:00:00.000Z",
      previous: {
        channelObservedQuantity: 3,
        channelCurrentQuantity: 2,
        channelQuantityUpdatedAt: VERSION,
        paidQuantity: 3,
        authorityFulfillableQuantity: 2,
        authorizationStatus: "partially_cancelled",
      },
    });
    expect(state).toMatchObject({
      staleChannelObservation: true,
      channelObservedQuantity: 3,
      channelCurrentQuantity: 2,
      paidQuantity: 3,
      authorityFulfillableQuantity: 2,
    });
  });
  it("rejects contradictory data for the same channel version", () => {
    expect(() =>
      observeChannelMerchandiseQuantity({
        purchasedQuantity: 3,
        currentQuantity: 3,
        updatedAt: VERSION,
        previous: {
          channelCurrentQuantity: 2,
          channelQuantityUpdatedAt: VERSION,
        },
      }),
    ).toThrow(
      expect.objectContaining({ code: "CHANNEL_QUANTITY_EVIDENCE_INVALID" }),
    );
  });
  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])(
    "rejects invalid quantity %s",
    (currentQuantity) => {
      expect(() =>
        observeChannelMerchandiseQuantity({
          purchasedQuantity: 3,
          currentQuantity,
          updatedAt: VERSION,
        }),
      ).toThrow();
    },
  );
  it("validates timestamps and bounds and does not mutate the observation", () => {
    expect(() =>
      observeChannelMerchandiseQuantity({
        purchasedQuantity: 1,
        currentQuantity: 2,
        updatedAt: VERSION,
      }),
    ).toThrow();
    expect(() =>
      observeChannelMerchandiseQuantity({
        purchasedQuantity: 1,
        currentQuantity: 1,
      }),
    ).toThrow();
    const input = Object.freeze({
      purchasedQuantity: 2_147_483_647,
      currentQuantity: 2_147_483_647,
      updatedAt: VERSION,
    });
    expect(
      observeChannelMerchandiseQuantity(input).channelCurrentQuantity,
    ).toBe(2_147_483_647);
    expect(input.updatedAt).toBe(VERSION);
  });
});
