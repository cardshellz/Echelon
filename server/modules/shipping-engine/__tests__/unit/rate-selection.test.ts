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
    destinationZone: "D49",
    minWeightGrams: 0,
    maxWeightGrams: 1000,
    rateCents: 899,
    ...overrides,
  };
}

const INPUT = { zone: "D49", billableWeightGrams: 500, originWarehouseId: 7 };

describe("selectParcelRates", () => {
  it("returns null for empty input", () => {
    expect(selectParcelRates([], INPUT)).toBeNull();
  });

  it("returns the matching row's quote", () => {
    const quotes = selectParcelRates([row()], INPUT);
    expect(quotes).toEqual([
      {
        carrier: "USPS",
        serviceCode: "usps_ground_advantage",
        currency: "USD",
        rateCents: 899,
        rateTableId: 1,
        warehouseSpecific: false,
      },
    ]);
  });

  it("excludes rows for a different zone", () => {
    expect(selectParcelRates([row({ destinationZone: "HIPRAK" })], INPUT)).toBeNull();
  });

  describe("weight bands", () => {
    it("includes the band minimum (min inclusive)", () => {
      const quotes = selectParcelRates([row({ minWeightGrams: 500, maxWeightGrams: 1000 })], INPUT);
      expect(quotes).toHaveLength(1);
    });

    it("includes the band maximum (max inclusive)", () => {
      const quotes = selectParcelRates([row({ minWeightGrams: 0, maxWeightGrams: 500 })], INPUT);
      expect(quotes).toHaveLength(1);
    });

    it("returns null when the weight is above every band", () => {
      const rows = [
        row({ minWeightGrams: 0, maxWeightGrams: 100 }),
        row({ minWeightGrams: 101, maxWeightGrams: 400, rateCents: 1099 }),
      ];
      expect(selectParcelRates(rows, INPUT)).toBeNull();
    });

    it("returns null when the weight is below every band", () => {
      const rows = [row({ minWeightGrams: 600, maxWeightGrams: 1000 })];
      expect(selectParcelRates(rows, INPUT)).toBeNull();
    });

    it("picks the cheapest when bands overlap the weight", () => {
      const rows = [
        row({ rateTableId: 1, minWeightGrams: 0, maxWeightGrams: 1000, rateCents: 1099 }),
        row({ rateTableId: 2, minWeightGrams: 400, maxWeightGrams: 600, rateCents: 899 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes).toHaveLength(1);
      expect(quotes?.[0].rateCents).toBe(899);
      expect(quotes?.[0].rateTableId).toBe(2);
    });

    it("returns null for a non-finite weight", () => {
      expect(selectParcelRates([row()], { ...INPUT, billableWeightGrams: Number.NaN })).toBeNull();
    });
  });

  describe("warehouse precedence", () => {
    it("excludes rows pinned to a different warehouse", () => {
      expect(selectParcelRates([row({ originWarehouseId: 99 })], INPUT)).toBeNull();
    });

    it("prefers a warehouse-specific row over a CHEAPER null-warehouse row", () => {
      // Mirrors dropship: (warehouse_id IS NULL) ASC sorts before rate_cents ASC.
      const rows = [
        row({ originWarehouseId: null, rateCents: 500 }),
        row({ originWarehouseId: 7, rateCents: 950 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes).toHaveLength(1);
      expect(quotes?.[0]).toMatchObject({ rateCents: 950, warehouseSpecific: true });
    });

    it("falls back to the null-warehouse row when no specific row covers the band", () => {
      const rows = [
        row({ originWarehouseId: 7, minWeightGrams: 2000, maxWeightGrams: 3000, rateCents: 950 }),
        row({ originWarehouseId: null, rateCents: 500 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes?.[0]).toMatchObject({ rateCents: 500, warehouseSpecific: false });
    });
  });

  describe("per-combo grouping and ordering", () => {
    it("cheapest wins within one (carrier, serviceCode)", () => {
      const rows = [
        row({ rateTableId: 1, rateCents: 999 }),
        row({ rateTableId: 2, rateCents: 899 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes).toHaveLength(1);
      expect(quotes?.[0].rateCents).toBe(899);
    });

    it("groups carrier/serviceCode case-insensitively", () => {
      const rows = [
        row({ carrier: "usps", serviceCode: "USPS_GROUND_ADVANTAGE", rateCents: 799 }),
        row({ carrier: "USPS", serviceCode: "usps_ground_advantage", rateCents: 899 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes).toHaveLength(1);
      expect(quotes?.[0].rateCents).toBe(799);
    });

    it("ties on price break by lowest rateTableId", () => {
      const rows = [
        row({ rateTableId: 9, rateCents: 899 }),
        row({ rateTableId: 3, rateCents: 899 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes?.[0].rateTableId).toBe(3);
    });

    it("returns every matching combo sorted cheapest-first", () => {
      const rows = [
        row({ carrier: "UPS", serviceCode: "ups_ground", rateCents: 1250, rateTableId: 2 }),
        row({ rateCents: 899 }),
        row({ carrier: "FedEx", serviceCode: "fedex_home_delivery", rateCents: 1100, rateTableId: 3 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes?.map((q) => [q.carrier, q.rateCents])).toEqual([
        ["USPS", 899],
        ["FedEx", 1100],
        ["UPS", 1250],
      ]);
    });

    it("breaks equal totals alphabetically for determinism", () => {
      const rows = [
        row({ carrier: "UPS", serviceCode: "ups_ground", rateCents: 899 }),
        row({ carrier: "FedEx", serviceCode: "fedex_home_delivery", rateCents: 899 }),
      ];
      const quotes = selectParcelRates(rows, INPUT);
      expect(quotes?.map((q) => q.carrier)).toEqual(["FedEx", "UPS"]);
    });
  });
});

describe("rateComboKey", () => {
  it("is case-insensitive and trimmed", () => {
    expect(rateComboKey(" USPS ", "Ground")).toBe(rateComboKey("usps", "ground"));
  });

  it("distinguishes different services on the same carrier", () => {
    expect(rateComboKey("usps", "ground")).not.toBe(rateComboKey("usps", "priority"));
  });
});
