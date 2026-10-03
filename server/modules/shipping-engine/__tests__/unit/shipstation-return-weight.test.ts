import { describe, expect, it } from "vitest";
import {
  matchesShipStationReturnWeight,
  shipStationReturnWeightPounds,
} from "../../infrastructure/shipstation-return-weight";

describe("ShipStation return weight conversion", () => {
  it.each([
    [1, 0.00220463],
    [500, 1.10231132],
    [850, 1.87392923],
    [907, 1.99959272],
    [22_679, 49.99863645],
  ])("declares %s whole grams as %s fractional pounds", (grams, expected) => {
    expect(shipStationReturnWeightPounds(grams)).toBe(expected);
  });

  it("preserves JSON precision and rounds up by less than one declared step across supported parcel weights", () => {
    // Independent integer arithmetic: one pound is exactly 45,359,237 / 100,000 g.
    for (let grams = 1; grams <= 22_680; grams++) {
      const value = shipStationReturnWeightPounds(grams);
      expect(value).not.toBeNull();
      expect(JSON.parse(JSON.stringify(value))).toBe(value);
      const [whole, fraction = ""] = String(value).split(".");
      expect(fraction.length).toBeLessThanOrEqual(8);
      const scaledPounds = BigInt(whole + fraction.padEnd(8, "0"));
      const excess = scaledPounds * BigInt(45_359_237) - BigInt(grams) * BigInt("10000000000000");
      expect(excess >= BigInt(0) && excess < BigInt(45_359_237)).toBe(true);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or unrepresentable canonical grams %s",
    grams => expect(shipStationReturnWeightPounds(grams)).toBeNull(),
  );
});

describe("ShipStation return weight verification", () => {
  it.each([
    { value: 500, unit: "gram" as const },
    { value: "0.5", unit: "kilogram" as const },
    { value: 1.10231132, unit: "pound" as const },
    { value: "1.102311320", unit: "pound" as const },
    { value: "17.63698112", unit: "ounce" as const },
    { value: "500.0000041166284", unit: "gram" as const },
  ])("accepts exact historical grams or declared pounds represented as %j", actual => {
    expect(matchesShipStationReturnWeight(actual, 500)).toBe(true);
  });

  it.each([
    { value: 501, unit: "gram" as const },
    { value: "499.999999", unit: "gram" as const },
    { value: "500.000001", unit: "gram" as const },
    { value: "1.10231131", unit: "pound" as const },
    { value: "1.10231133", unit: "pound" as const },
    { value: "1.1023113201", unit: "pound" as const },
    { value: 0, unit: "pound" as const },
    { value: -1, unit: "pound" as const },
    { value: Number.NaN, unit: "pound" as const },
    { value: Number.POSITIVE_INFINITY, unit: "pound" as const },
    { value: "invalid", unit: "pound" as const },
  ])("rejects malformed or changed weights without a blanket tolerance %j", actual => {
    expect(matchesShipStationReturnWeight(actual, 500)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid canonical weight %s during verification",
    grams => expect(matchesShipStationReturnWeight({ value: 1, unit: "pound" }, grams)).toBe(false),
  );
});
