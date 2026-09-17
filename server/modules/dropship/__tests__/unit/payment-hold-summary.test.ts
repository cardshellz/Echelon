import { describe, expect, it } from "vitest";
import { summarizePaymentHolds } from "../../domain/payment-hold-summary";

const expiresAt = new Date("2026-09-18T12:00:00.000Z");

describe("summarizePaymentHolds", () => {
  it("asks for exactly the gap between what the holds need and what the wallet has", () => {
    expect(summarizePaymentHolds({
      heldCount: 2,
      totalDebitCents: 19_000,
      availableBalanceCents: 4_000,
      earliestExpiresAt: expiresAt,
      currency: "USD",
    })).toEqual({
      heldCount: 2,
      totalDebitCents: 19_000,
      availableBalanceCents: 4_000,
      earliestExpiresAt: expiresAt,
      currency: "USD",
      shortfallCents: 15_000,
    });
  });

  it("asks for nothing when the balance already covers every held order", () => {
    expect(summarizePaymentHolds({
      heldCount: 1,
      totalDebitCents: 9_500,
      availableBalanceCents: 9_500,
      earliestExpiresAt: expiresAt,
      currency: "USD",
    }).shortfallCents).toBe(0);
    expect(summarizePaymentHolds({
      heldCount: 1,
      totalDebitCents: 9_500,
      availableBalanceCents: 20_000,
      earliestExpiresAt: expiresAt,
      currency: "USD",
    }).shortfallCents).toBe(0);
  });

  it("widens the gap by a negative balance, which must be cleared before any hold can be paid", () => {
    expect(summarizePaymentHolds({
      heldCount: 1,
      totalDebitCents: 9_500,
      availableBalanceCents: -1_200,
      earliestExpiresAt: expiresAt,
      currency: "USD",
    }).shortfallCents).toBe(10_700);
  });

  it("reports no shortfall when nothing is held, whatever the balance", () => {
    expect(summarizePaymentHolds({
      heldCount: 0,
      totalDebitCents: 0,
      availableBalanceCents: -500,
      earliestExpiresAt: null,
      currency: "USD",
    }).shortfallCents).toBe(0);
  });

  it("refuses fractional cents and negative counts or totals", () => {
    const base = { heldCount: 1, totalDebitCents: 100, availableBalanceCents: 0, earliestExpiresAt: null, currency: "USD" };
    expect(() => summarizePaymentHolds({ ...base, totalDebitCents: 10.5 })).toThrow(RangeError);
    expect(() => summarizePaymentHolds({ ...base, availableBalanceCents: Number.NaN })).toThrow(RangeError);
    expect(() => summarizePaymentHolds({ ...base, heldCount: -1 })).toThrow(RangeError);
    expect(() => summarizePaymentHolds({ ...base, totalDebitCents: -1 })).toThrow(RangeError);
  });
});
