import { describe, expect, it } from "vitest";
import {
  DROPSHIP_AUTOPAY_REFILL_INVALID,
  decideAutopayRefill,
  deriveSingleChargeBoundCents,
} from "../../domain/autopay-refill";

const MINIMUM = 10_000;

function refill(overrides: Partial<Parameters<typeof decideAutopayRefill>[0]> = {}) {
  return decideAutopayRefill({
    availableBalanceCents: 9_500,
    pendingBalanceCents: 0,
    minimumBalanceCents: MINIMUM,
    topUpAmountCents: null,
    singleChargeBoundCents: null,
    ...overrides,
  });
}

describe("deriveSingleChargeBoundCents", () => {
  it("is the minimum, or the top-up amount when that is larger", () => {
    expect(deriveSingleChargeBoundCents({ minimumBalanceCents: MINIMUM, topUpAmountCents: null })).toBe(MINIMUM);
    expect(deriveSingleChargeBoundCents({ minimumBalanceCents: MINIMUM, topUpAmountCents: 5_000 })).toBe(MINIMUM);
    expect(deriveSingleChargeBoundCents({ minimumBalanceCents: MINIMUM, topUpAmountCents: 25_000 })).toBe(25_000);
  });

  it("refuses money that is not a non-negative safe integer number of cents", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => deriveSingleChargeBoundCents({ minimumBalanceCents: bad, topUpAmountCents: null }))
        .toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
      expect(() => deriveSingleChargeBoundCents({ minimumBalanceCents: MINIMUM, topUpAmountCents: bad }))
        .toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
    }
  });
});

describe("decideAutopayRefill", () => {
  it("does nothing while the balance, counting credits still settling, is at the minimum", () => {
    expect(refill({ availableBalanceCents: MINIMUM })).toEqual({ outcome: "not_needed" });
    expect(refill({ availableBalanceCents: 12_000 })).toEqual({ outcome: "not_needed" });
    // A refill already on its way counts, so it is never stacked.
    expect(refill({ availableBalanceCents: 2_000, pendingBalanceCents: 8_000 })).toEqual({ outcome: "not_needed" });
  });

  it("pulls the minimum for a small dip by default, so refills are few", () => {
    expect(refill()).toEqual({
      outcome: "refill", amountCents: MINIMUM, shortfallCents: 500, requestedCents: MINIMUM, boundCents: MINIMUM, partial: false,
    });
  });

  it("pulls the top-up amount the vendor chose", () => {
    expect(refill({ topUpAmountCents: 25_000 })).toEqual({
      outcome: "refill", amountCents: 25_000, shortfallCents: 500, requestedCents: 25_000, boundCents: 25_000, partial: false,
    });
    // Smaller than the minimum is allowed: the bound stays at the minimum.
    expect(refill({ topUpAmountCents: 4_000 })).toMatchObject({ amountCents: 4_000, boundCents: MINIMUM, partial: false });
  });

  it("pulls the whole shortfall when that is more than the top-up amount, up to the bound", () => {
    // Derived bound = max(minimum, top-up) = 15,000: an 18,000 shortfall is cut short.
    expect(refill({ availableBalanceCents: -8_000, topUpAmountCents: 15_000 })).toEqual({
      outcome: "refill", amountCents: 15_000, shortfallCents: 18_000, requestedCents: 18_000, boundCents: 15_000, partial: true,
    });
    // A stored bound that covers it: the whole shortfall in one pull.
    expect(refill({ availableBalanceCents: -8_000, topUpAmountCents: 15_000, singleChargeBoundCents: 20_000 })).toEqual({
      outcome: "refill", amountCents: 18_000, shortfallCents: 18_000, requestedCents: 18_000, boundCents: 20_000, partial: false,
    });
  });

  it("never pulls more than the bound: a deep negative is collected over several runs", () => {
    expect(refill({ availableBalanceCents: -50_000, singleChargeBoundCents: 20_000 })).toEqual({
      outcome: "refill", amountCents: 20_000, shortfallCents: 60_000, requestedCents: 60_000, boundCents: 20_000, partial: true,
    });
  });

  it("honours a stored bound even below the derived one, and pulls nothing when the bound is zero", () => {
    expect(refill({ singleChargeBoundCents: 5_000 })).toMatchObject({ amountCents: 5_000, boundCents: 5_000, partial: false });
    expect(refill({ availableBalanceCents: 2_000, singleChargeBoundCents: 5_000 })).toMatchObject({ amountCents: 5_000, shortfallCents: 8_000, partial: true });
    expect(refill({ singleChargeBoundCents: 0 })).toEqual({ outcome: "not_needed" });
  });

  it("refuses malformed money", () => {
    expect(() => refill({ availableBalanceCents: 1.5 })).toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
    expect(() => refill({ pendingBalanceCents: -1 })).toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
    expect(() => refill({ minimumBalanceCents: -1 })).toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
    expect(() => refill({ topUpAmountCents: -1 })).toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
    expect(() => refill({ singleChargeBoundCents: Number.NaN })).toThrowError(expect.objectContaining({ code: DROPSHIP_AUTOPAY_REFILL_INVALID }));
  });
});
