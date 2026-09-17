import { describe, expect, it } from "vitest";
import {
  describeHeldOrder,
  describePaymentHoldSummary,
  formatTimeUntil,
  isWaitingOnPayment,
  ordersStatusFilterFromSearch,
  type DropshipPaymentHoldSummary,
} from "../dropship-payment-holds";
import type { DropshipOrderListItem } from "../dropship-ops-surface";

const now = new Date("2026-09-16T12:00:00.000Z");

function summary(overrides: Partial<DropshipPaymentHoldSummary> = {}): DropshipPaymentHoldSummary {
  return {
    heldCount: 2,
    totalDebitCents: 19_000,
    availableBalanceCents: 4_000,
    shortfallCents: 15_000,
    earliestExpiresAt: "2026-09-17T15:30:00.000Z",
    currency: "USD",
    ...overrides,
  };
}

function order(overrides: Partial<DropshipOrderListItem> = {}): DropshipOrderListItem {
  return {
    intakeId: 1,
    vendor: { vendorId: 10, memberId: "m-1", businessName: "Vendor", email: null, status: "active", entitlementStatus: "active" },
    platform: "ebay",
    externalOrderId: "EXT-1",
    externalOrderNumber: "1001",
    status: "payment_hold",
    paymentHoldExpiresAt: "2026-09-17T15:30:00.000Z",
    paymentHold: { totalDebitCents: 9_500, currency: "USD", expiresAt: "2026-09-17T15:30:00.000Z" },
    rejectionReason: null,
    cancellationStatus: null,
    omsOrderId: null,
    receivedAt: "2026-09-16T10:00:00.000Z",
    acceptedAt: null,
    updatedAt: "2026-09-16T10:00:00.000Z",
    lineCount: 1,
    totalQuantity: 1,
    shipTo: null,
    storeConnection: { storeConnectionId: 22, platform: "ebay", status: "connected", setupStatus: "ready", launchReady: true, externalDisplayName: "Shop", shopDomain: null },
    ...overrides,
  };
}

describe("formatTimeUntil", () => {
  it("reads as days, hours or minutes depending on how much is left", () => {
    expect(formatTimeUntil("2026-09-17T15:30:00.000Z", now)).toBe("1d 3h");
    expect(formatTimeUntil("2026-09-16T15:05:00.000Z", now)).toBe("3h 5m");
    expect(formatTimeUntil("2026-09-16T12:12:00.000Z", now)).toBe("12m");
    expect(formatTimeUntil("2026-09-16T12:00:30.000Z", now)).toBe("under a minute");
  });

  it("says past due once the deadline has gone, and nothing without one", () => {
    expect(formatTimeUntil("2026-09-16T12:00:00.000Z", now)).toBe("past due");
    expect(formatTimeUntil("2026-09-15T12:00:00.000Z", now)).toBe("past due");
    expect(formatTimeUntil(null, now)).toBeNull();
    expect(formatTimeUntil("not a date", now)).toBeNull();
  });
});

describe("describePaymentHoldSummary", () => {
  it("tells the vendor how many orders wait, what to add, and how long the first one has", () => {
    expect(describePaymentHoldSummary(summary(), now)).toEqual({
      title: "2 orders are waiting on payment",
      needs: "They need $190.00 in total; your balance is $40.00.",
      action: "Add $150.00 to accept them.",
      deadline: "The first one is cancelled in 1d 3h if it is not paid.",
      needsFunds: true,
    });
  });

  it("reads naturally for a single order and when the balance already covers it", () => {
    expect(describePaymentHoldSummary(summary({ heldCount: 1, totalDebitCents: 9_500, availableBalanceCents: 12_000, shortfallCents: 0 }), now)).toEqual({
      title: "1 order is waiting on payment",
      needs: "It needs $95.00 in total; your balance is $120.00.",
      action: "Your balance covers it now. Accept it from the orders list.",
      deadline: "The first one is cancelled in 1d 3h if it is not paid.",
      needsFunds: false,
    });
  });

  it("flags a deadline that has already passed, and is silent when nothing is held", () => {
    expect(describePaymentHoldSummary(summary({ earliestExpiresAt: "2026-09-16T11:00:00.000Z" }), now)?.deadline)
      .toBe("The first one is past its deadline and will be cancelled.");
    expect(describePaymentHoldSummary(summary({ heldCount: 0, totalDebitCents: 0, shortfallCents: 0, earliestExpiresAt: null }), now)).toBeNull();
  });
});

describe("describeHeldOrder", () => {
  it("shows what a held order needs and how long it has", () => {
    expect(describeHeldOrder(order(), now)).toBe("Needs $95.00 · cancels in 1d 3h");
    expect(describeHeldOrder(order({ paymentHold: { totalDebitCents: 9_500, currency: "USD", expiresAt: "2026-09-16T11:00:00.000Z" } }), now))
      .toBe("Needs $95.00 · past due");
  });

  it("still marks a held order without a recorded amount, and ignores orders that are not held", () => {
    expect(describeHeldOrder(order({ paymentHold: null }), now)).toBe("Waiting on payment · cancels in 1d 3h");
    expect(describeHeldOrder(order({ paymentHold: null, paymentHoldExpiresAt: null }), now)).toBe("Waiting on payment");
    expect(describeHeldOrder(order({ status: "accepted", paymentHold: null }), now)).toBeNull();
    expect(isWaitingOnPayment({ status: "payment_hold" })).toBe(true);
    expect(isWaitingOnPayment({ status: "received" })).toBe(false);
  });
});

describe("ordersStatusFilterFromSearch", () => {
  it("applies a status the page offers and ignores anything else", () => {
    const offered = ["all", "received", "payment_hold"];
    expect(ordersStatusFilterFromSearch("?status=payment_hold", offered)).toBe("payment_hold");
    expect(ordersStatusFilterFromSearch("?status=bogus", offered)).toBe("all");
    expect(ordersStatusFilterFromSearch("", offered)).toBe("all");
    expect(ordersStatusFilterFromSearch("?search=x", offered)).toBe("all");
  });
});
