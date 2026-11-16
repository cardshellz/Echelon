import { describe, expect, it } from "vitest";

import { deriveOmsLineAuthority, type OmsLineAuthorityInput } from "../../oms-line-authority";
import {
  OMS_LINE_AWAITING_CHANNEL_PAYMENT,
  OMS_PAID_QUANTITY_BELOW_CHANNEL,
  deriveShopifyChannelPaymentSettled,
  summarizeChannelAuthorityGap,
} from "../../domain/channel-payment-settlement";

// Fixed clock: authority results must not depend on wall time.
const NOW = new Date("2026-11-16T19:09:05.000Z");
const ORIGINAL_VERSION = "2026-11-16T12:54:09-05:00";
const EDIT_VERSION = "2026-11-16T14:09:02-05:00";

/**
 * Production #65696 (OMS line 127120, GLV-MAG-35PT-P50): authorized at 8 by
 * orders/paid; a Shopify-admin edit raised it to 10 and lowered the total, so
 * the only events afterwards were orders/updated + a $2.65 refund.
 */
const PAID_AT_EIGHT = {
  channelObservedQuantity: 8,
  channelCurrentQuantity: 8,
  channelQuantityUpdatedAt: ORIGINAL_VERSION,
  paidQuantity: 8,
  authorityFulfillableQuantity: 8,
  cancelledQuantity: 0,
  refundedQuantity: 0,
  authorizationStatus: "authorized",
  authorizedAt: new Date("2026-11-16T17:54:18.979Z"),
  authorizedByEventId: "webhook_inbox:234783",
};

function editedToTen(overrides: Partial<OmsLineAuthorityInput> = {}): OmsLineAuthorityInput {
  return {
    sourceTopic: "orders/updated",
    sourceEventId: "webhook_inbox:234867",
    sourceInboxId: 234867,
    financialStatus: "paid",
    quantity: 10,
    currentQuantity: 10,
    fulfillableQuantity: 10,
    channelUpdatedAt: EDIT_VERSION,
    channelPaymentSettled: true,
    previous: PAID_AT_EIGHT,
    now: NOW,
    ...overrides,
  };
}

describe("deriveShopifyChannelPaymentSettled", () => {
  it.each([
    ["paid", "0.00", true],
    ["paid", "-2.65", true], // #65696 before the refund: customer overpaid
    ["partially_refunded", "0.00", true],
    ["PAID", "0", true],
    ["paid", "5.00", false], // an edit raised the total; money still owed
    ["partially_paid", "0.00", false],
    ["pending", "0.00", false],
    ["refunded", "0.00", false],
    ["voided", "-1.00", false],
    [null, "0.00", false],
  ])("financial_status=%s total_outstanding=%s -> %s", (financialStatus, totalOutstanding, expected) => {
    expect(deriveShopifyChannelPaymentSettled({ financialStatus, totalOutstanding })).toBe(expected);
  });

  it("returns null when Shopify did not state an outstanding balance", () => {
    expect(deriveShopifyChannelPaymentSettled({ financialStatus: "paid", totalOutstanding: undefined })).toBeNull();
    expect(deriveShopifyChannelPaymentSettled({ financialStatus: "paid", totalOutstanding: null })).toBeNull();
  });

  it("throws on a malformed amount instead of authorizing", () => {
    expect(() => deriveShopifyChannelPaymentSettled({ financialStatus: "paid", totalOutstanding: "abc" }))
      .toThrow(/total_outstanding/);
    expect(() => deriveShopifyChannelPaymentSettled({ financialStatus: "paid", totalOutstanding: "0.001" }))
      .toThrow(/total_outstanding/);
  });
});

describe("settled channel snapshot raises paid authority (#65696)", () => {
  it("authorizes the edited quantity when Shopify says the order is fully paid", () => {
    const authority = deriveOmsLineAuthority(editedToTen());
    expect(authority).toMatchObject({
      channelObservedQuantity: 10,
      channelCurrentQuantity: 10,
      paidQuantity: 10,
      authorityFulfillableQuantity: 10,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:234867",
      authoritySourceTopic: "orders/updated",
      authoritySourceInboxId: 234867,
    });
  });

  it("the reconciler poll applies the same rule", () => {
    const authority = deriveOmsLineAuthority(editedToTen({
      sourceTopic: "shopify/reconcile",
      sourceEventId: "shopify-reconcile:12354542174367:" + EDIT_VERSION,
      sourceInboxId: null,
    }));
    expect(authority.paidQuantity).toBe(10);
    expect(authority.authorityFulfillableQuantity).toBe(10);
  });

  it("is idempotent: replaying the same settled snapshot changes nothing", () => {
    const first = deriveOmsLineAuthority(editedToTen());
    const replay = deriveOmsLineAuthority(editedToTen({
      sourceEventId: "webhook_inbox:234868",
      sourceInboxId: 234868,
      previous: { ...first, cancelledQuantity: 0, refundedQuantity: 0 },
    }));
    expect(replay.paidQuantity).toBe(10);
    expect(replay.authorityFulfillableQuantity).toBe(10);
    // The original grant stays the authorizing event.
    expect(replay.authorizedByEventId).toBe("webhook_inbox:234867");
  });

  it("keeps the old paid quantity while Shopify says money is still owed", () => {
    const authority = deriveOmsLineAuthority(editedToTen({ channelPaymentSettled: false }));
    expect(authority.paidQuantity).toBe(8);
    expect(authority.authorityFulfillableQuantity).toBe(8);
    expect(authority.channelCurrentQuantity).toBe(10);
  });

  it("keeps the old paid quantity when Shopify did not state payment (legacy payloads)", () => {
    const authority = deriveOmsLineAuthority(editedToTen({ channelPaymentSettled: null }));
    expect(authority.paidQuantity).toBe(8);
    expect(authority.authorityFulfillableQuantity).toBe(8);
  });

  it("never authorizes from a stale snapshot, even one that says settled", () => {
    const authority = deriveOmsLineAuthority(editedToTen({
      channelUpdatedAt: "2026-11-16T12:00:00-05:00",
    }));
    expect(authority.staleChannelObservation).toBe(true);
    expect(authority.paidQuantity).toBe(8);
    expect(authority.authorityFulfillableQuantity).toBe(8);
  });

  it("does not authorize without a dated current_quantity", () => {
    const authority = deriveOmsLineAuthority(editedToTen({ currentQuantity: null }));
    expect(authority.paidQuantity).toBe(8);
  });

  it("does not let other topics use the settled rule", () => {
    const authority = deriveOmsLineAuthority(editedToTen({ sourceTopic: "orders/fulfilled" }));
    expect(authority.paidQuantity).toBe(8);
  });

  it.each([
    ["review", 0, 0],
    ["partially_refunded", 0, 1],
    ["partially_cancelled", 1, 0],
    ["cancelled", 0, 0],
  ])("leaves a %s line to its owning command", (authorizationStatus, cancelledQuantity, refundedQuantity) => {
    const authority = deriveOmsLineAuthority(editedToTen({
      previous: { ...PAID_AT_EIGHT, authorizationStatus, cancelledQuantity, refundedQuantity },
    }));
    expect(authority.paidQuantity).toBe(8);
    expect(authority.authorityFulfillableQuantity).toBeLessThanOrEqual(8);
  });

  it("leaves reductions on the existing path (an edit removing units)", () => {
    const authority = deriveOmsLineAuthority(editedToTen({ quantity: 8, currentQuantity: 6, fulfillableQuantity: 6 }));
    expect(authority).toMatchObject({
      paidQuantity: 8,
      authorityFulfillableQuantity: 6,
      authorizationStatus: "partially_cancelled",
      authorizedByEventId: "webhook_inbox:234783",
    });
  });

  it("keeps cumulative authority on a partly fulfilled line that gains units", () => {
    // 10 paid, 4 already fulfilled; edit adds 2 -> Shopify current 12, fulfillable 8.
    const authority = deriveOmsLineAuthority(editedToTen({
      quantity: 12,
      currentQuantity: 12,
      fulfillableQuantity: 8,
      previous: { ...PAID_AT_EIGHT, channelObservedQuantity: 10, channelCurrentQuantity: 10, paidQuantity: 10, authorityFulfillableQuantity: 10 },
    }));
    expect(authority.paidQuantity).toBe(12);
    expect(authority.authorityFulfillableQuantity).toBe(12);
  });

  it("authorizes a brand-new edit line on a partially_refunded but settled order", () => {
    const authority = deriveOmsLineAuthority(editedToTen({
      financialStatus: "partially_refunded",
      quantity: 2,
      currentQuantity: 2,
      fulfillableQuantity: 2,
      previous: null,
    }));
    expect(authority.paidQuantity).toBe(2);
    expect(authority.authorityFulfillableQuantity).toBe(2);
  });

  it("does not mutate its input", () => {
    const input = editedToTen();
    const snapshot = JSON.stringify(input);
    deriveOmsLineAuthority(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("summarizeChannelAuthorityGap", () => {
  const line = {
    id: 127120,
    sku: "GLV-MAG-35PT-P50",
    quantity: 10,
    channelCurrentQuantity: 10,
    paidQuantity: 8,
    authorizationStatus: "authorized",
    requiresShipping: true,
  };

  it("reports a fully paid order whose units OMS will not ship as a defect", () => {
    expect(summarizeChannelAuthorityGap({ lines: [line], channelPaymentSettled: true })).toEqual({
      code: OMS_PAID_QUANTITY_BELOW_CHANNEL,
      signature: `${OMS_PAID_QUANTITY_BELOW_CHANNEL}|127120:10:8`,
      lines: [{ orderLineId: 127120, sku: "GLV-MAG-35PT-P50", channelQuantity: 10, paidQuantity: 8, unauthorizedQuantity: 2 }],
    });
  });

  it("reports unsettled orders as awaiting payment", () => {
    expect(summarizeChannelAuthorityGap({ lines: [line], channelPaymentSettled: false })?.code)
      .toBe(OMS_LINE_AWAITING_CHANNEL_PAYMENT);
    expect(summarizeChannelAuthorityGap({ lines: [line], channelPaymentSettled: null })?.code)
      .toBe(OMS_LINE_AWAITING_CHANNEL_PAYMENT);
  });

  it("returns null when every bought unit is authorized", () => {
    expect(summarizeChannelAuthorityGap({ lines: [{ ...line, paidQuantity: 10 }], channelPaymentSettled: true })).toBeNull();
    expect(summarizeChannelAuthorityGap({ lines: [], channelPaymentSettled: true })).toBeNull();
  });

  it("ignores non-shipping lines and lines owned by cancel/refund/review", () => {
    for (const authorizationStatus of ["cancelled", "partially_cancelled", "refunded", "partially_refunded", "review"]) {
      expect(summarizeChannelAuthorityGap({ lines: [{ ...line, authorizationStatus }], channelPaymentSettled: true })).toBeNull();
    }
    expect(summarizeChannelAuthorityGap({ lines: [{ ...line, requiresShipping: false }], channelPaymentSettled: true })).toBeNull();
  });

  it("falls back to quantity when Shopify never sent current_quantity", () => {
    const gap = summarizeChannelAuthorityGap({ lines: [{ ...line, channelCurrentQuantity: null }], channelPaymentSettled: true });
    expect(gap?.lines[0].channelQuantity).toBe(10);
  });

  it("has an order-independent signature", () => {
    const other = { ...line, id: 5, sku: "X", quantity: 3, channelCurrentQuantity: 3, paidQuantity: 1 };
    const a = summarizeChannelAuthorityGap({ lines: [line, other], channelPaymentSettled: true });
    const b = summarizeChannelAuthorityGap({ lines: [other, line], channelPaymentSettled: true });
    expect(a?.signature).toBe(b?.signature);
  });

  it("rejects corrupt quantities", () => {
    expect(() => summarizeChannelAuthorityGap({ lines: [{ ...line, paidQuantity: -1 }], channelPaymentSettled: true }))
      .toThrow(/paidQuantity/);
  });
});
