import { describe, expect, it, vi } from "vitest";
import * as feeModule from "@shared/dropship/wallet-funding-fee";
import {
  ASSUMED_BANK_SETTLEMENT_BUSINESS_DAYS,
  BANK_SETTLEMENT_PHRASE,
  CARD_EXPIRY_WARNING_MONTHS,
  activationTopUp,
  chargeBoundCents,
  cardExpiryState,
  depositAmountDefault,
  firstFillFeeCents,
  formatDurationMinutes,
  formatSignedCents,
  formatWholeDollars,
  largestCoverableOrderCents,
  presetsIncluding,
  shortfallExample,
} from "../dropship-wallet-guidance";

const LIMITS = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };
const BPS = 300;

describe("constants", () => {
  it("pins the product decisions by name and value", () => {
    expect(ASSUMED_BANK_SETTLEMENT_BUSINESS_DAYS).toBe(5);
    expect(BANK_SETTLEMENT_PHRASE).toBe("up to 5 business days (our assumption)");
    expect(CARD_EXPIRY_WARNING_MONTHS).toBe(2);
  });
});

describe("presets", () => {
  it("adds what is already saved to the presets, sorted, and ignores blanks", () => {
    expect(presetsIncluding([100, 300], 200, null, 300)).toEqual([100, 200, 300]);
    expect(presetsIncluding([2_500, 5_000], 0, -1, 1.5)).toEqual([2_500, 5_000]);
  });
});

describe("example A: bank vendor", () => {
  it("bounds one charge at the larger of the minimum and the top-up amount, and quotes the activation top-up as $250 pending", () => {
    expect(chargeBoundCents(25_000, null)).toBe(25_000);
    expect(chargeBoundCents(25_000, 10_000)).toBe(25_000);
    expect(chargeBoundCents(25_000, 40_000)).toBe(40_000);
    expect(largestCoverableOrderCents(25_000, 50_000)).toBe(75_000);
    expect(largestCoverableOrderCents(0, 50_000)).toBe(50_000);
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: null, availableCents: 0, pendingCents: 0, bps: BPS }))
      .toEqual({ outcome: "top_up", amountCents: 25_000, feeCents: 0, chargedCents: 25_000, lands: "pending", partial: false });
    // A small dip still pulls the whole top-up amount, the minimum by default.
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: null, availableCents: 24_000, pendingCents: 0, bps: BPS }))
      .toMatchObject({ outcome: "top_up", amountCents: 25_000, partial: false });
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: 40_000, availableCents: 24_000, pendingCents: 0, bps: BPS }))
      .toMatchObject({ outcome: "top_up", amountCents: 40_000, partial: false });
    expect(shortfallExample({ orderCents: 7_500, availableCents: 2_000, bps: BPS })).toEqual({ shortfallCents: 5_500, feeCents: 165, chargedCents: 5_665 });
    expect(shortfallExample({ orderCents: 1_000, availableCents: 2_000, bps: BPS })).toEqual({ shortfallCents: 0, feeCents: 0, chargedCents: 0 });
  });
});

describe("example B: bank vendor with a large minimum", () => {
  it("defaults the deposit to the minimum within the funding limits, and quotes a large shortfall", () => {
    expect(depositAmountDefault(300_000, LIMITS)).toBe(300_000);
    expect(depositAmountDefault(600_000, LIMITS)).toBe(500_000);
    expect(depositAmountDefault(500, LIMITS)).toBe(1_000);
    expect(shortfallExample({ orderCents: 40_000, availableCents: 5_000, bps: BPS })).toEqual({ shortfallCents: 35_000, feeCents: 1_050, chargedCents: 36_050 });
  });
});

describe("example C: card vendor", () => {
  it("charges the first fill once at the fee rate and quotes the activation charge", () => {
    expect(firstFillFeeCents(10_000, BPS)).toBe(300);
    expect(firstFillFeeCents(100_000, BPS)).toBe(3_000);
    expect(activationTopUp({ sourceRail: "stripe_card", floorCents: 10_000, topUpCents: null, availableCents: 0, pendingCents: 0, bps: BPS }))
      .toEqual({ outcome: "top_up", amountCents: 10_000, feeCents: 300, chargedCents: 10_300, lands: "instant", partial: false });
  });
});

describe("example D: bank vendor below zero", () => {
  it("takes the signed balance everywhere without throwing", () => {
    // Below zero by $50 with a $250 minimum: the shortfall is $300, but one charge never exceeds the bound; the next daily check continues.
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: null, availableCents: -5_000, pendingCents: 0, bps: BPS }))
      .toEqual({ outcome: "top_up", amountCents: 25_000, feeCents: 0, chargedCents: 25_000, lands: "pending", partial: true });
    expect(activationTopUp({ sourceRail: "stripe_card", floorCents: 25_000, topUpCents: null, availableCents: -5_000, pendingCents: 0, bps: BPS }))
      .toMatchObject({ outcome: "top_up", chargedCents: 25_750, partial: true });
    // A top-up amount large enough covers the whole shortfall in one pull.
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: 50_000, availableCents: -5_000, pendingCents: 0, bps: BPS }))
      .toEqual({ outcome: "top_up", amountCents: 50_000, feeCents: 0, chargedCents: 50_000, lands: "pending", partial: false });
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: null, availableCents: 0, pendingCents: 25_000, bps: BPS })).toEqual({ outcome: "not_needed" });
    expect(activationTopUp({ sourceRail: "stripe_ach", floorCents: 25_000, topUpCents: null, availableCents: -60_000, pendingCents: 0, bps: BPS }))
      .toEqual({ outcome: "top_up", amountCents: 25_000, feeCents: 0, chargedCents: 25_000, lands: "pending", partial: true });
    expect(largestCoverableOrderCents(-5_000, 50_000)).toBe(45_000);
    expect(largestCoverableOrderCents(-60_000, 50_000)).toBe(0);
    expect(shortfallExample({ orderCents: 7_500, availableCents: -5_000, bps: BPS })).toEqual({ shortfallCents: 12_500, feeCents: 375, chargedCents: 12_875 });
  });
});

describe("the signed contract", () => {
  it("rejects negative or fractional amounts and never hands a negative to the fee helper", () => {
    const spy = vi.spyOn(feeModule, "calculateCardFundingFeeCents");
    expect(() => firstFillFeeCents(-1, BPS)).toThrow(RangeError);
    expect(() => chargeBoundCents(1.5, null)).toThrow(RangeError);
    expect(() => chargeBoundCents(25_000, -1)).toThrow(RangeError);
    expect(() => largestCoverableOrderCents(1.5, 100)).toThrow(RangeError);
    expect(() => largestCoverableOrderCents(-100, -1)).toThrow(RangeError);
    shortfallExample({ orderCents: 100, availableCents: -100_000, bps: BPS });
    activationTopUp({ sourceRail: "stripe_card", floorCents: 100, topUpCents: 1_000_000, availableCents: -500_000, pendingCents: -10, bps: BPS });
    for (const call of spy.mock.calls) expect(call[0]).toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });
});

describe("card expiry and durations", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  it("warns two months ahead with an injected clock", () => {
    expect(cardExpiryState({ expMonth: 9, expYear: 2026 }, now)).toBe("expiring");
    expect(cardExpiryState({ expMonth: 11, expYear: 2026 }, now)).toBe("expiring");
    expect(cardExpiryState({ expMonth: 12, expYear: 2026 }, now)).toBe("ok");
    expect(cardExpiryState({ expMonth: 8, expYear: 2026 }, now)).toBe("expired");
    expect(cardExpiryState({ expMonth: 1, expYear: 2027 }, now)).toBe("ok");
    expect(cardExpiryState({ expMonth: null, expYear: null }, now)).toBe("unknown");
  });
  it("formats durations", () => {
    expect(formatDurationMinutes(45)).toBe("45 minutes");
    expect(formatDurationMinutes(60)).toBe("1 hour");
    expect(formatDurationMinutes(90)).toBe("1 hour 30 minutes");
    expect(formatDurationMinutes(120)).toBe("2 hours");
    expect(formatDurationMinutes(2_880)).toBe("48 hours");
    expect(formatDurationMinutes(10_080)).toBe("7 days");
    expect(() => formatDurationMinutes(0)).toThrow(RangeError);
    expect(() => formatDurationMinutes(1.5)).toThrow(RangeError);
  });
  it("formats money for display", () => {
    expect(formatWholeDollars(25_000)).toBe("$250");
    expect(formatWholeDollars(750)).toBe("$7.50");
    expect(formatWholeDollars(-5_000)).toBe("−$50");
    expect(formatSignedCents(-5_000)).toBe("−$50.00");
    expect(formatSignedCents(123_456)).toBe("$1,234.56");
  });
});
