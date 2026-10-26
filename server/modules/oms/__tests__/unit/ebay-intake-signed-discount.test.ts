import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

import { dollarsToCents } from "../../ebay-order-ingestion";

// 7493a0b96 (2026-10-25) parsed eBay amounts unsigned. eBay reports
// pricingSummary.priceDiscount as a negative amount, so every eBay order with a
// seller discount threw at intake and was retried on every poll, never ingested.

describe("eBay intake amounts", () => {
  it("reads a negative discount exactly, as before 10-25", () => {
    expect(dollarsToCents("-1.50")).toBe(-150);
    expect(dollarsToCents("-0.05")).toBe(-5);
  });

  it("reads ordinary amounts and treats a missing amount as zero", () => {
    expect(dollarsToCents("12.34")).toBe(1234);
    expect(dollarsToCents("7")).toBe(700);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents(null)).toBe(0);
  });

  it("still rejects malformed money instead of guessing", () => {
    expect(() => dollarsToCents("1.234")).toThrow("dollarsToCents: invalid dollars amount");
    expect(() => dollarsToCents("abc")).toThrow();
  });
});
