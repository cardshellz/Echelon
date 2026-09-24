import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALLET_REWARDS_RATES,
  DROPSHIP_WALLET_REWARDS_INVALID,
  MAX_REWARDS_RATE_BPS,
  calculateRewardsEarnedCents,
  decideRewardsAccrual,
  decideRewardsClawback,
  decideRewardsSpend,
  isValidRewardsRateBps,
  rewardsRateForRail,
} from "../../domain/wallet-rewards";

const rates = { bankBps: 100, usdcBps: 150, cardBps: 0 };

describe("rewards rates", () => {
  it("launch rates: bank and USDC earn 1%, card earns nothing", () => {
    expect(DEFAULT_WALLET_REWARDS_RATES).toEqual({ bankBps: 100, usdcBps: 100, cardBps: 0 });
  });

  it("picks the rail's rate; a manual staff credit never earns", () => {
    expect(rewardsRateForRail(rates, "stripe_ach")).toBe(100);
    expect(rewardsRateForRail(rates, "usdc_base")).toBe(150);
    expect(rewardsRateForRail(rates, "stripe_card")).toBe(0);
    expect(rewardsRateForRail(rates, "manual")).toBe(0);
  });

  it("the ceiling is 10%; a rate above it or a fraction is invalid", () => {
    expect(MAX_REWARDS_RATE_BPS).toBe(1_000);
    expect(isValidRewardsRateBps(0)).toBe(true);
    expect(isValidRewardsRateBps(1_000)).toBe(true);
    expect(isValidRewardsRateBps(1_001)).toBe(false);
    expect(isValidRewardsRateBps(-1)).toBe(false);
    expect(isValidRewardsRateBps(12.5)).toBe(false);
    expect(() => rewardsRateForRail({ ...rates, bankBps: 1_001 }, "stripe_ach")).toThrowError(
      expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }),
    );
  });
});

describe("calculateRewardsEarnedCents", () => {
  it("rounds down to the cent", () => {
    expect(calculateRewardsEarnedCents(100_000, 100)).toBe(1_000);
    expect(calculateRewardsEarnedCents(99, 100)).toBe(0);
    expect(calculateRewardsEarnedCents(199, 100)).toBe(1);
    expect(calculateRewardsEarnedCents(12_345, 250)).toBe(308);
  });

  it("a zero rate or a zero amount earns nothing", () => {
    expect(calculateRewardsEarnedCents(100_000, 0)).toBe(0);
    expect(calculateRewardsEarnedCents(0, 100)).toBe(0);
  });

  it("stays exact on amounts beyond the double-precision product", () => {
    expect(calculateRewardsEarnedCents(Number.MAX_SAFE_INTEGER, 1_000)).toBe(900_719_925_474_099);
  });

  it("refuses a negative or fractional amount and an invalid rate", () => {
    expect(() => calculateRewardsEarnedCents(-1, 100)).toThrowError(expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }));
    expect(() => calculateRewardsEarnedCents(10.5, 100)).toThrowError(expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }));
    expect(() => calculateRewardsEarnedCents(100, 1_001)).toThrowError(expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }));
  });
});

describe("decideRewardsAccrual", () => {
  it("a settled bank transfer of $250 earns $2.50 at 1%", () => {
    expect(decideRewardsAccrual({ rail: "stripe_ach", creditAmountCents: 25_000, rates })).toEqual({ rateBps: 100, rewardsCents: 250 });
  });

  it("a card charge earns nothing at the launch rate, and a manual credit never does", () => {
    expect(decideRewardsAccrual({ rail: "stripe_card", creditAmountCents: 25_000, rates })).toEqual({ rateBps: 0, rewardsCents: 0 });
    expect(decideRewardsAccrual({ rail: "manual", creditAmountCents: 25_000, rates: { bankBps: 500, usdcBps: 500, cardBps: 500 } }))
      .toEqual({ rateBps: 0, rewardsCents: 0 });
  });
});

describe("decideRewardsSpend", () => {
  it("rewards pay first, up to the balance; cash pays the rest", () => {
    expect(decideRewardsSpend({ rewardsBalanceCents: 300, totalDebitCents: 1_000, spendRewardsFirst: true })).toEqual({ rewardsCents: 300, cashCents: 700 });
  });

  it("rewards can pay the whole order, and never more than it", () => {
    expect(decideRewardsSpend({ rewardsBalanceCents: 5_000, totalDebitCents: 1_000, spendRewardsFirst: true })).toEqual({ rewardsCents: 1_000, cashCents: 0 });
  });

  it("a vendor saving their rewards pays from cash alone", () => {
    expect(decideRewardsSpend({ rewardsBalanceCents: 5_000, totalDebitCents: 1_000, spendRewardsFirst: false })).toEqual({ rewardsCents: 0, cashCents: 1_000 });
  });

  it("a vendor who has not chosen keeps their rewards: auto-apply is never a default", () => {
    expect(decideRewardsSpend({ rewardsBalanceCents: 5_000, totalDebitCents: 1_000, spendRewardsFirst: null })).toEqual({ rewardsCents: 0, cashCents: 1_000 });
    // Anything that is not an explicit choice is refused, never read as one.
    expect(() => decideRewardsSpend({ rewardsBalanceCents: 5_000, totalDebitCents: 1_000, spendRewardsFirst: undefined as unknown as boolean })).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_WALLET_REWARDS_INVALID" }),
    );
    expect(() => decideRewardsSpend({ rewardsBalanceCents: 5_000, totalDebitCents: 1_000, spendRewardsFirst: "true" as unknown as boolean })).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_WALLET_REWARDS_INVALID" }),
    );
  });

  it("no rewards means no rewards part", () => {
    expect(decideRewardsSpend({ rewardsBalanceCents: 0, totalDebitCents: 1_000, spendRewardsFirst: true })).toEqual({ rewardsCents: 0, cashCents: 1_000 });
  });

  it("refuses a non-positive debit", () => {
    expect(() => decideRewardsSpend({ rewardsBalanceCents: 0, totalDebitCents: 0, spendRewardsFirst: true })).toThrowError(
      expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }),
    );
  });
});

describe("decideRewardsClawback", () => {
  it("a full reversal takes back everything the credit earned, from the rewards balance when it is there", () => {
    expect(decideRewardsClawback({ earnedCents: 1_000, creditAmountCents: 100_000, reversalCents: 100_000, rewardsBalanceCents: 1_500 }))
      .toEqual({ clawbackCents: 1_000, fromRewardsCents: 1_000, fromCashCents: 0 });
  });

  it("rewards already spent come out of cash instead; the rewards balance never goes negative", () => {
    expect(decideRewardsClawback({ earnedCents: 1_000, creditAmountCents: 100_000, reversalCents: 100_000, rewardsBalanceCents: 400 }))
      .toEqual({ clawbackCents: 1_000, fromRewardsCents: 400, fromCashCents: 600 });
    expect(decideRewardsClawback({ earnedCents: 1_000, creditAmountCents: 100_000, reversalCents: 100_000, rewardsBalanceCents: 0 }))
      .toEqual({ clawbackCents: 1_000, fromRewardsCents: 0, fromCashCents: 1_000 });
  });

  it("a partial dispute takes back its share, rounded down", () => {
    expect(decideRewardsClawback({ earnedCents: 1_000, creditAmountCents: 100_000, reversalCents: 40_000, rewardsBalanceCents: 1_000 }))
      .toEqual({ clawbackCents: 400, fromRewardsCents: 400, fromCashCents: 0 });
    expect(decideRewardsClawback({ earnedCents: 1, creditAmountCents: 199, reversalCents: 100, rewardsBalanceCents: 1 }))
      .toEqual({ clawbackCents: 0, fromRewardsCents: 0, fromCashCents: 0 });
  });

  it("a credit that earned nothing claws back nothing", () => {
    expect(decideRewardsClawback({ earnedCents: 0, creditAmountCents: 100_000, reversalCents: 100_000, rewardsBalanceCents: 900 }))
      .toEqual({ clawbackCents: 0, fromRewardsCents: 0, fromCashCents: 0 });
  });

  it("refuses a reversal larger than the credit and a zero credit", () => {
    expect(() => decideRewardsClawback({ earnedCents: 10, creditAmountCents: 100, reversalCents: 101, rewardsBalanceCents: 0 }))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }));
    expect(() => decideRewardsClawback({ earnedCents: 10, creditAmountCents: 0, reversalCents: 0, rewardsBalanceCents: 0 }))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_WALLET_REWARDS_INVALID }));
  });
});
