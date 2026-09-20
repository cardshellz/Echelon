import { describe, expect, it } from "vitest";
import {
  DROPSHIP_DISPUTE_STATUSES,
  DROPSHIP_FUNDING_REVERSAL_INVALID,
  DROPSHIP_FUNDING_REVERSAL_STANDING_REASON,
  decideFundingReversal,
  disputeOutcomeFor,
  disputeWithdrawsFunds,
} from "../../domain/funding-reversal";
import { DropshipError } from "../../domain/errors";

const settledCredit = { amountCents: 5_000, currency: "USD", status: "settled" };
const usd = (amountCents: number) => ({ amountCents, currency: "USD" });

describe("disputeWithdrawsFunds", () => {
  it("is true only while the funds are gone: the two active statuses and a loss", () => {
    expect(DROPSHIP_DISPUTE_STATUSES.filter(disputeWithdrawsFunds)).toEqual(["needs_response", "under_review", "lost"]);
  });
});

describe("disputeOutcomeFor", () => {
  it("reads what the status means for the money", () => {
    expect(disputeOutcomeFor("won")).toBe("won");
    expect(disputeOutcomeFor("prevented")).toBe("won");
    expect(disputeOutcomeFor("lost")).toBe("lost");
    // An inquiry that closed never took anything, so there is nothing to stand or return.
    expect(disputeOutcomeFor("warning_closed")).toBe("inquiry_closed");
    for (const status of ["warning_needs_response", "warning_under_review", "needs_response", "under_review"] as const) {
      expect(disputeOutcomeFor(status)).toBe("open");
    }
  });
});

describe("decideFundingReversal", () => {
  it("reverses the disputed amount, never more than the credit put in", () => {
    expect(decideFundingReversal({ credit: settledCredit, dispute: usd(5_000) })).toEqual({ outcome: "reverse", reversalCents: 5_000 });
    // A card credit was charged plus the card fee: the fee above the credit is Card Shellz's loss, not the vendor's.
    expect(decideFundingReversal({ credit: settledCredit, dispute: usd(5_150) })).toEqual({ outcome: "reverse", reversalCents: 5_000 });
    // A partial dispute takes back only what was disputed.
    expect(decideFundingReversal({ credit: settledCredit, dispute: usd(1_000) })).toEqual({ outcome: "reverse", reversalCents: 1_000 });
  });

  it("compares currencies without regard to case", () => {
    expect(decideFundingReversal({ credit: settledCredit, dispute: { amountCents: 5_000, currency: "usd" } }))
      .toEqual({ outcome: "reverse", reversalCents: 5_000 });
  });

  it("ignores a credit that never settled, a dispute in another currency, and a dispute of nothing", () => {
    expect(decideFundingReversal({ credit: { ...settledCredit, status: "pending" }, dispute: usd(5_000) }))
      .toEqual({ outcome: "ignore", reason: "credit_not_settled" });
    expect(decideFundingReversal({ credit: { ...settledCredit, status: "failed" }, dispute: usd(5_000) }))
      .toEqual({ outcome: "ignore", reason: "credit_not_settled" });
    expect(decideFundingReversal({ credit: settledCredit, dispute: { amountCents: 5_000, currency: "EUR" } }))
      .toEqual({ outcome: "ignore", reason: "currency_mismatch" });
    expect(decideFundingReversal({ credit: settledCredit, dispute: usd(0) }))
      .toEqual({ outcome: "ignore", reason: "nothing_to_reverse" });
    expect(decideFundingReversal({ credit: { ...settledCredit, amountCents: 0 }, dispute: usd(5_000) }))
      .toEqual({ outcome: "ignore", reason: "nothing_to_reverse" });
  });

  it("refuses money that is not a non-negative safe integer number of cents", () => {
    for (const amountCents of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decideFundingReversal({ credit: settledCredit, dispute: usd(amountCents) }))
        .toThrowError(expect.objectContaining({ code: DROPSHIP_FUNDING_REVERSAL_INVALID }));
      expect(() => decideFundingReversal({ credit: { ...settledCredit, amountCents }, dispute: usd(1) }))
        .toThrowError(DropshipError);
    }
  });

  it("pauses a reversed vendor under the existing funding_returned reason", () => {
    expect(DROPSHIP_FUNDING_REVERSAL_STANDING_REASON).toBe("funding_returned");
  });
});
