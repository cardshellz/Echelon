import { describe, expect, it } from "vitest";
import {
  rateComboKey,
  selectParcelRates,
  type RateCandidateRow,
} from "../../domain/rate-selection";

function row(overrides: Partial<RateCandidateRow> = {}): RateCandidateRow {
  return {
    rateTableId: 1,
    carrier: "USPS",
    serviceCode: "usps_ground_advantage",
    currency: "USD",
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minWeightGrams: 0,
    maxWeightGrams: 1000,
    rateCents: 899,
    ...overrides,
  };
}

const INPUT = {
  destinationCountry: "US",
  destinationRegion: "PA",
  destinationPostal: "16066",
  billableWeightGrams: 500,
  originWarehouseId: 7,
};

describe("selectParcelRates", () => {
  it("returns null for empty input", () => {
    expect(selectParcelRates([], INPUT)).toBeNull();
  });

  it("returns the matching statewide row", () => {
    expect(selectParcelRates([row()], INPUT)).toEqual([{
      carrier: "USPS",
      serviceCode: "usps_ground_advantage",
      currency: "USD",
      rateCents: 899,
      rateTableId: 1,
      warehouseSpecific: false,
      postalSpecific: false,
    }]);
  });

  it("excludes rows for a different country or state", () => {
    expect(selectParcelRates([row({ destinationRegion: "OH" })], INPUT)).toBeNull();
    expect(selectParcelRates([row({ destinationCountry: "CA" })], INPUT)).toBeNull();
  });

  it("uses the longest matching ZIP prefix before the statewide fallback", () => {
    const quotes = selectParcelRates([
      row({ rateCents: 500 }),
      row({ postalPrefix: "160", rateCents: 700 }),
      row({ postalPrefix: "16066", rateCents: 900 }),
      row({ postalPrefix: "191", rateCents: 100 }),
    ], INPUT);
    expect(quotes?.[0]).toMatchObject({ rateCents: 900, postalSpecific: true });
  });

  it("falls back to statewide when no ZIP override matches", () => {
    const quotes = selectParcelRates([
      row({ rateCents: 800 }),
      row({ postalPrefix: "191", rateCents: 500 }),
    ], INPUT);
    expect(quotes?.[0]).toMatchObject({ rateCents: 800, postalSpecific: false });
  });

  describe("weight bands", () => {
    it("includes both band boundaries", () => {
      expect(selectParcelRates([row({ minWeightGrams: 500 })], INPUT)).toHaveLength(1);
      expect(selectParcelRates([row({ maxWeightGrams: 500 })], INPUT)).toHaveLength(1);
    });

    it("returns null outside every band or for non-finite weight", () => {
      expect(selectParcelRates([row({ maxWeightGrams: 499 })], INPUT)).toBeNull();
      expect(selectParcelRates([row({ minWeightGrams: 501 })], INPUT)).toBeNull();
      expect(selectParcelRates([row()], { ...INPUT, billableWeightGrams: Number.NaN })).toBeNull();
    });
  });

  describe("warehouse precedence", () => {
    it("excludes rows pinned to a different warehouse", () => {
      expect(selectParcelRates([row({ originWarehouseId: 99 })], INPUT)).toBeNull();
    });

    it("prefers a warehouse-specific row over a cheaper global row", () => {
      const quotes = selectParcelRates([
        row({ originWarehouseId: null, rateCents: 500 }),
        row({ originWarehouseId: 7, rateCents: 950 }),
      ], INPUT);
      expect(quotes?.[0]).toMatchObject({ rateCents: 950, warehouseSpecific: true });
    });

    it("falls back to a global row when the warehouse row misses the weight", () => {
      const quotes = selectParcelRates([
        row({ originWarehouseId: 7, minWeightGrams: 2000, maxWeightGrams: 3000 }),
        row({ originWarehouseId: null, rateCents: 500 }),
      ], INPUT);
      expect(quotes?.[0]).toMatchObject({ rateCents: 500, warehouseSpecific: false });
    });
  });

  it("returns every carrier/service combination sorted cheapest first", () => {
    const quotes = selectParcelRates([
      row({ carrier: "UPS", serviceCode: "ups_ground", rateCents: 1250, rateTableId: 2 }),
      row({ rateCents: 899 }),
      row({ carrier: "FedEx", serviceCode: "fedex_home_delivery", rateCents: 1100, rateTableId: 3 }),
    ], INPUT);
    expect(quotes?.map((quote) => [quote.carrier, quote.rateCents])).toEqual([
      ["USPS", 899],
      ["FedEx", 1100],
      ["UPS", 1250],
    ]);
  });

  it("groups carrier and service case-insensitively", () => {
    const quotes = selectParcelRates([
      row({ carrier: "usps", serviceCode: "USPS_GROUND_ADVANTAGE", rateCents: 799 }),
      row({ carrier: "USPS", serviceCode: "usps_ground_advantage", rateCents: 899 }),
    ], INPUT);
    expect(quotes).toHaveLength(1);
    expect(quotes?.[0].rateCents).toBe(799);
  });
});

describe("rateComboKey", () => {
  it("is case-insensitive and trimmed", () => {
    expect(rateComboKey(" USPS ", "Ground")).toBe(rateComboKey("usps", "ground"));
  });

  it("distinguishes services", () => {
    expect(rateComboKey("usps", "ground")).not.toBe(rateComboKey("usps", "priority"));
  });
});
