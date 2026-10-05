import { describe, expect, it } from "vitest";
import {
  matchesShipStationReturnWeight,
  shipStationReturnWeightPounds,
} from "../../infrastructure/shipstation-return-weight";

describe("ShipStation return weight conversion", () => {
  it.each([
    [5, 0.01],
    [453, 0.99],
    [454, 1],
    [500, 1.1],
    [850, 1.87],
    [907, 1.99],
    [9_071, 19.99],
    [22_679, 49.99],
    [22_680, 50],
  ])("rounds %s whole grams down to %s pounds for quotes and purchases", (grams, expected) => {
    expect(shipStationReturnWeightPounds(grams)).toBe(expected);
  });

  it("preserves JSON precision and truncates by less than 0.01 lb across supported parcel weights", () => {
    // Independent integer arithmetic: one pound is exactly 45,359,237 / 100,000 g.
    for (let grams = 5; grams <= 22_680; grams++) {
      const value = shipStationReturnWeightPounds(grams);
      expect(value).not.toBeNull();
      expect(JSON.parse(JSON.stringify(value))).toBe(value);
      const [whole, fraction = ""] = String(value).split(".");
      expect(fraction.length).toBeLessThanOrEqual(2);
      const hundredthsPounds = BigInt(whole + fraction.padEnd(2, "0"));
      const shortfall = BigInt(grams) * BigInt("10000000") - hundredthsPounds * BigInt(45_359_237);
      expect(shortfall >= BigInt(0) && shortfall < BigInt(45_359_237)).toBe(true);
      expect(matchesShipStationReturnWeight({ value: value!, unit: "pound" }, grams)).toBe(true);
    }
  });

  it.each([0, 1, 2, 3, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid, zero-normalized or unrepresentable canonical grams %s",
    grams => expect(shipStationReturnWeightPounds(grams)).toBeNull(),
  );
});

describe("ShipStation return weight verification", () => {
  it.each([
    { value: 1.1, unit: "pound" as const },
    { value: "1.10", unit: "pound" as const },
    { value: "17.6", unit: "ounce" as const },
    { value: "498.951607", unit: "gram" as const },
    { value: "0.498951607", unit: "kilogram" as const },
  ])("accepts the exact submitted weight in a supported unit %j", actual => {
    expect(matchesShipStationReturnWeight(actual, 500)).toBe(true);
  });
  it.each([
    { value: 1.86, unit: "pound" as const },
    { value: 1.88, unit: "pound" as const },
    { value: "1.870001", unit: "pound" as const },
    { value: "848.217732", unit: "gram" as const },
    { value: "29.920001", unit: "ounce" as const },
    { value: "0.848217732", unit: "kilogram" as const },
  ])("rejects changed normalized weights during purchase and recovery %j", actual => {
    for (const mode of ["purchase", "recover"] as const) {
      expect(matchesShipStationReturnWeight(actual, 850, mode)).toBe(false);
    }
  });
  it.each([
    { value: 500, unit: "gram" as const },
    { value: "0.5", unit: "kilogram" as const },
    { value: 1.10231132, unit: "pound" as const },
    { value: "1.102311320", unit: "pound" as const },
    { value: "17.63698112", unit: "ounce" as const },
    { value: "500.0000041166284", unit: "gram" as const },
  ])("accepts exact historical formats only for read-only recovery %j", actual => {
    expect(matchesShipStationReturnWeight(actual, 500, "recover")).toBe(true);
    expect(matchesShipStationReturnWeight(actual, 500, "purchase")).toBe(false);
  });

  it.each([[907, "2.00"], [22_679, 50]] as const)(
    "accepts the historical two-decimal readback of %s grams as %s only during recovery", (grams, value) => {
      expect(matchesShipStationReturnWeight({ value, unit: "pound" }, grams, "recover")).toBe(true);
      expect(matchesShipStationReturnWeight({ value, unit: "pound" }, grams, "purchase")).toBe(false);
    },
  );
  it("still recovers a tiny historical label without allowing a zero-weight new purchase", () => {
    expect(shipStationReturnWeightPounds(1)).toBeNull();
    expect(matchesShipStationReturnWeight({ value: 1, unit: "gram" }, 1, "recover")).toBe(true);
    expect(matchesShipStationReturnWeight({ value: 1, unit: "gram" }, 1, "purchase")).toBe(false);
  });
  it.each([0, "0", "0.00", "-0.00", -1, Number.NaN, Number.POSITIVE_INFINITY, "invalid"])(
    "rejects nonpositive or malformed readbacks %s in both modes", value => {
      for (const mode of ["purchase", "recover"] as const) {
        expect(matchesShipStationReturnWeight({ value, unit: "pound" }, 1, mode)).toBe(false);
      }
    },
  );
  it.each(["1.10231131", "1.10231133", "1.1023113201"])(
    "does not relax historical recovery into a tolerance for %s", value => {
      expect(matchesShipStationReturnWeight({ value, unit: "pound" }, 500, "recover")).toBe(false);
    },
  );
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid canonical weight %s during verification",
    grams => expect(matchesShipStationReturnWeight({ value: 1, unit: "pound" }, grams)).toBe(false),
  );
});
