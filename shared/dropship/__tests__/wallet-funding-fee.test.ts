import { describe, expect, it } from "vitest";
import {
  BASIS_POINTS_PER_WHOLE,
  DEFAULT_CARD_FUNDING_FEE_BPS,
  MAX_CARD_FUNDING_FEE_BPS,
  calculateCardFundingFeeCents,
  formatFeeRate,
  isValidCardFundingFeeBps,
  quoteWalletFunding,
} from "../wallet-funding-fee";

describe("calculateCardFundingFeeCents", () => {
  it("charges the launch rate exactly on whole-dollar amounts", () => {
    expect(DEFAULT_CARD_FUNDING_FEE_BPS).toBe(300);
    expect(calculateCardFundingFeeCents(10_000, 300)).toBe(300);
    expect(calculateCardFundingFeeCents(25_000, 300)).toBe(750);
    expect(calculateCardFundingFeeCents(5_500, 300)).toBe(165);
  });

  it("rounds half up at the sub-cent boundary", () => {
    expect(calculateCardFundingFeeCents(1_234, 300)).toBe(37); // 37.02
    expect(calculateCardFundingFeeCents(1_250, 300)).toBe(38); // 37.50 → 38
    expect(calculateCardFundingFeeCents(1_249, 300)).toBe(37); // 37.47
    expect(calculateCardFundingFeeCents(1, 300)).toBe(0); // 0.03
    expect(calculateCardFundingFeeCents(17, 300)).toBe(1); // 0.51
  });

  it("is zero at a zero rate or a zero amount", () => {
    expect(calculateCardFundingFeeCents(10_000, 0)).toBe(0);
    expect(calculateCardFundingFeeCents(0, 300)).toBe(0);
  });

  it("handles the largest manual top-up and the full-rate ceiling without floating point drift", () => {
    expect(calculateCardFundingFeeCents(500_000, 300)).toBe(15_000);
    expect(calculateCardFundingFeeCents(500_000, BASIS_POINTS_PER_WHOLE)).toBe(500_000);
    expect(calculateCardFundingFeeCents(Number.MAX_SAFE_INTEGER, 0)).toBe(0);
  });

  it("refuses fractional, negative, unsafe or out-of-range inputs", () => {
    expect(() => calculateCardFundingFeeCents(12.5, 300)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(-1, 300)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(Number.NaN, 300)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(100, 300.5)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(100, -1)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(100, BASIS_POINTS_PER_WHOLE + 1)).toThrow(RangeError);
    expect(() => calculateCardFundingFeeCents(Number.MAX_SAFE_INTEGER, 300)).toThrow(RangeError);
  });
});

describe("quoteWalletFunding", () => {
  it("puts the fee on top for a card: the wallet receives exactly the credit", () => {
    expect(quoteWalletFunding({ rail: "stripe_card", creditCents: 10_000, cardFeeBps: 300 })).toEqual({
      rail: "stripe_card",
      creditCents: 10_000,
      feeCents: 300,
      feeBps: 300,
      chargedCents: 10_300,
    });
  });

  it("charges bank transfers and USDC exactly the credit, at a zero rate", () => {
    for (const rail of ["stripe_ach", "usdc_base", "manual"]) {
      expect(quoteWalletFunding({ rail, creditCents: 10_000, cardFeeBps: 300 })).toEqual({
        rail,
        creditCents: 10_000,
        feeCents: 0,
        feeBps: 0,
        chargedCents: 10_000,
      });
    }
  });

  it("records a zero rate on a card as applied, not absent", () => {
    expect(quoteWalletFunding({ rail: "stripe_card", creditCents: 10_000, cardFeeBps: 0 })).toEqual({
      rail: "stripe_card",
      creditCents: 10_000,
      feeCents: 0,
      feeBps: 0,
      chargedCents: 10_000,
    });
  });

  it("validates the credit and the rate before quoting any rail", () => {
    expect(() => quoteWalletFunding({ rail: "stripe_ach", creditCents: 0.5, cardFeeBps: 300 })).toThrow(RangeError);
    expect(() => quoteWalletFunding({ rail: "stripe_ach", creditCents: 100, cardFeeBps: -5 })).toThrow(RangeError);
  });
});

describe("isValidCardFundingFeeBps", () => {
  it("accepts whole rates from zero to the misconfiguration ceiling", () => {
    expect(isValidCardFundingFeeBps(0)).toBe(true);
    expect(isValidCardFundingFeeBps(300)).toBe(true);
    expect(isValidCardFundingFeeBps(MAX_CARD_FUNDING_FEE_BPS)).toBe(true);
  });

  it("rejects everything else, including a rate that would be a typo", () => {
    expect(isValidCardFundingFeeBps(MAX_CARD_FUNDING_FEE_BPS + 1)).toBe(false);
    expect(isValidCardFundingFeeBps(-1)).toBe(false);
    expect(isValidCardFundingFeeBps(2.5)).toBe(false);
    expect(isValidCardFundingFeeBps("300")).toBe(false);
    expect(isValidCardFundingFeeBps(Number.NaN)).toBe(false);
    expect(isValidCardFundingFeeBps(undefined)).toBe(false);
  });
});

describe("formatFeeRate", () => {
  it("drops trailing zeros and keeps meaningful fractions", () => {
    expect(formatFeeRate(300)).toBe("3%");
    expect(formatFeeRate(250)).toBe("2.5%");
    expect(formatFeeRate(25)).toBe("0.25%");
    expect(formatFeeRate(1_000)).toBe("10%");
    expect(formatFeeRate(0)).toBe("0%");
  });
});
