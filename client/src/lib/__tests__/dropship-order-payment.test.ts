import { describe, expect, it } from "vitest";
import { describeHeldOrderNeed, describeOrderAcceptance, describeOrderPayment } from "../dropship-order-payment";

const cashRow = { walletLedgerEntryId: 70, type: "order_debit", status: "settled", amountCents: -9_000, currency: "USD", availableBalanceAfterCents: 41_000, pendingBalanceAfterCents: 0, createdAt: "2026-09-20T00:00:00.000Z", settledAt: "2026-09-20T00:00:00.000Z" };
const rewardsRow = { walletLedgerEntryId: 71, amountCents: -500, rewardsBalanceAfterCents: 250, createdAt: "2026-09-20T00:00:00.000Z" };

describe("an order's wallet payment in the vendor's words (funding design phase 7)", () => {
  it("shows both parts of a split payment, and the balance each left", () => {
    expect(describeOrderPayment({ walletLedgerEntry: cashRow, walletRewardsEntry: rewardsRow })).toEqual([
      { label: "Paid from your wallet", value: "$95.00" },
      { label: "From rewards", value: "$5.00" },
      { label: "From cash", value: "$90.00" },
      { label: "Status", value: "Settled" },
      { label: "Cash balance after", value: "$410.00" },
      { label: "Rewards balance after", value: "$2.50" },
    ]);
  });

  it("shows a cash-only order without a rewards line, and a rewards-only order without a cash line", () => {
    expect(describeOrderPayment({ walletLedgerEntry: cashRow, walletRewardsEntry: null })).toEqual([
      { label: "Paid from your wallet", value: "$90.00" },
      { label: "Status", value: "Settled" },
      { label: "Cash balance after", value: "$410.00" },
    ]);
    // A server that predates the rewards row serves no field at all: same words as a cash-only order.
    expect(describeOrderPayment({ walletLedgerEntry: cashRow })).toEqual(describeOrderPayment({ walletLedgerEntry: cashRow, walletRewardsEntry: null }));
    expect(describeOrderPayment({ walletLedgerEntry: null, walletRewardsEntry: { ...rewardsRow, amountCents: -9_500, rewardsBalanceAfterCents: 0 } })).toEqual([
      { label: "Paid from your wallet", value: "$95.00" },
      { label: "From rewards", value: "$95.00" },
      { label: "From cash", value: "$0.00" },
      { label: "Rewards balance after", value: "$0.00" },
    ]);
  });

  it("says nothing for an order without wallet rows, and never renders a missing or broken snapshot as a number", () => {
    expect(describeOrderPayment({ walletLedgerEntry: null, walletRewardsEntry: null })).toBeNull();
    expect(describeOrderPayment({ walletLedgerEntry: { ...cashRow, availableBalanceAfterCents: null }, walletRewardsEntry: { ...rewardsRow, rewardsBalanceAfterCents: null } }))
      .toEqual(expect.arrayContaining([{ label: "Cash balance after", value: "Not recorded" }, { label: "Rewards balance after", value: "Not recorded" }]));
    expect(() => describeOrderPayment({ walletLedgerEntry: { ...cashRow, amountCents: 1.5 }, walletRewardsEntry: null })).toThrow(RangeError);
  });

  it("splits what a held order still needs into the rewards part and the cash it waits for", () => {
    expect(describeHeldOrderNeed({ totalDebitCents: 9_500, rewardsCents: 500, currency: "USD", expiresAt: null })).toEqual([
      { label: "Amount needed", value: "$95.00" },
      { label: "Rewards will cover", value: "$5.00" },
      { label: "Cash still needed", value: "$90.00" },
    ]);
    // No rewards part, an unknown one (a hold from before rewards) and an old server all read as the total alone.
    expect(describeHeldOrderNeed({ totalDebitCents: 9_500, rewardsCents: 0, currency: "USD", expiresAt: null })).toEqual([{ label: "Amount needed", value: "$95.00" }]);
    expect(describeHeldOrderNeed({ totalDebitCents: 9_500, rewardsCents: null, currency: "USD", expiresAt: null })).toEqual([{ label: "Amount needed", value: "$95.00" }]);
    expect(describeHeldOrderNeed({ totalDebitCents: 9_500, currency: "USD", expiresAt: null })).toEqual([{ label: "Amount needed", value: "$95.00" }]);
    // Rewards paying the whole hold leaves nothing for cash; more than the total is a server fault, not a negative figure.
    expect(describeHeldOrderNeed({ totalDebitCents: 9_500, rewardsCents: 9_500, currency: "USD", expiresAt: null })[2]).toEqual({ label: "Cash still needed", value: "$0.00" });
    expect(() => describeHeldOrderNeed({ totalDebitCents: 9_500, rewardsCents: 9_501, currency: "USD", expiresAt: null })).toThrow(RangeError);
    expect(() => describeHeldOrderNeed({ totalDebitCents: -1, rewardsCents: 0, currency: "USD", expiresAt: null })).toThrow(RangeError);
  });

  it("names the rewards part in the acceptance outcome only when there is one", () => {
    const base = { outcome: "accepted" as const, intakeId: 42, vendorId: 1, storeConnectionId: 2, shippingQuoteSnapshotId: 3, omsOrderId: 9, walletLedgerEntryId: 70, economicsSnapshotId: 55, totalDebitCents: 9_500, currency: "USD", paymentHoldExpiresAt: null, idempotentReplay: false,
      quote: { quoteSnapshotId: 3, idempotentReplay: false, warehouseId: 1, packageCount: 1, totalShippingCents: 500, currency: "USD", carrierServices: [] } };
    expect(describeOrderAcceptance({ ...base, rewardsCents: 500 })).toBe("Order intake 42 accepted for $95.00 ($5.00 from rewards).");
    expect(describeOrderAcceptance({ ...base, rewardsCents: 0 })).toBe("Order intake 42 accepted for $95.00.");
    expect(describeOrderAcceptance(base)).toBe("Order intake 42 accepted for $95.00.");
    expect(describeOrderAcceptance({ ...base, outcome: "payment_hold", rewardsCents: 500 })).toBe("Order intake 42 placed on payment hold for $95.00 ($5.00 from rewards).");
    expect(() => describeOrderAcceptance({ ...base, rewardsCents: -5 })).toThrow(RangeError);
  });
});
