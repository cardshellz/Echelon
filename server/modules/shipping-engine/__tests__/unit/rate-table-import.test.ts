import { describe, expect, it } from "vitest";
import {
  CENTS_PER_USD,
  GRAMS_PER_POUND,
  findBandOverlaps,
  findMissingStateDefaults,
  parseRateTableCsv,
  type RateTableImportRow,
} from "../../domain/rate-table-import";

function row(overrides: Partial<RateTableImportRow> = {}): RateTableImportRow {
  return {
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minMeasure: 0,
    maxMeasure: 1000,
    maxShipmentWeightGrams: null,
    rateCents: 899,
    ...overrides,
  };
}

describe("parseRateTableCsv", () => {
  it("parses parcel state defaults and ZIP overrides", () => {
    const result = parseRateTableCsv(
      "state,zip_prefix,min_lb,max_lb,rate_usd\nPA,,0,1,8.99\nPA,160,0,1,7.99\n",
    );
    expect(result).toMatchObject({
      pricingMode: "state_zip",
      pricingBasis: "shipment_weight",
      dialect: "pounds",
      errors: [],
    });
    expect(result.rows[0]).toMatchObject({
      destinationRegion: "PA",
      postalPrefix: null,
      minMeasure: 0,
      maxMeasure: 454,
      maxShipmentWeightGrams: null,
      rateCents: 899,
    });
  });

  it("parses pallet-count bands with an optional total-weight ceiling", () => {
    const result = parseRateTableCsv([
      "state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd",
      "PA,,1,2,2500,189.00",
      "OH,,3,4,,299.00",
    ].join("\n"));
    expect(result).toMatchObject({
      pricingBasis: "pallet_count",
      dialect: "pallets",
      errors: [],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        destinationRegion: "PA",
        minMeasure: 1,
        maxMeasure: 2,
        maxShipmentWeightGrams: Math.round(2500 * GRAMS_PER_POUND),
        rateCents: 18900,
      }),
      expect.objectContaining({
        destinationRegion: "OH",
        minMeasure: 3,
        maxMeasure: 4,
        maxShipmentWeightGrams: null,
        rateCents: 29900,
      }),
    ]);
  });

  it("rejects invalid geography and pallet quantities", () => {
    const result = parseRateTableCsv([
      "state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd",
      "Atlantis,,1,2,2500,189",
      "PA,16A,1,2,2500,189",
      "PA,,0,2,2500,189",
    ].join("\n"));
    expect(result.errors.map((error) => error.message)).toEqual([
      'invalid US state or territory "Atlantis"',
      "zip_prefix must contain 1 to 5 digits",
      "minimum pallet count must be 1 or greater",
    ]);
  });

  it("converts parcel pounds and dollars with deterministic rounding", () => {
    const result = parseRateTableCsv("state,min_lb,max_lb,rate_usd\nPA,0,0.5,4.15\n");
    expect(result.rows[0].maxMeasure).toBe(Math.round(0.5 * GRAMS_PER_POUND));
    expect(result.rows[0].rateCents).toBe(Math.round(4.15 * CENTS_PER_USD));
  });

  it("accepts whole storage units in the grams dialect", () => {
    const result = parseRateTableCsv("state,min_g,max_g,rate_cents\nPA,0,1000,1599\n");
    expect(result.dialect).toBe("grams");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ minMeasure: 0, maxMeasure: 1000, rateCents: 1599 });
  });

  it("reports empty files and enforces the row cap", () => {
    expect(parseRateTableCsv("\n\n").errors).toEqual([
      { line: 1, message: "CSV is empty - a header row is required" },
    ]);
    const result = parseRateTableCsv(
      "state,min_g,max_g,rate_cents\nPA,0,10,100\nPA,11,20,200\nPA,21,30,300\n",
      { maxRows: 2 },
    );
    expect(result.rows).toEqual([]);
    expect(result.errors[0].line).toBe(4);
  });
});

describe("findBandOverlaps", () => {
  it("accepts adjacent bands and rejects inclusive overlaps", () => {
    expect(findBandOverlaps([
      row({ minMeasure: 0, maxMeasure: 1000 }),
      row({ minMeasure: 1001, maxMeasure: 2000 }),
    ])).toEqual([]);
    expect(findBandOverlaps([
      row({ minMeasure: 0, maxMeasure: 1000 }),
      row({ minMeasure: 1000, maxMeasure: 2000 }),
    ])).toHaveLength(1);
  });
});

describe("findMissingStateDefaults", () => {
  it("requires ZIP fallbacks in the same warehouse scope", () => {
    expect(findMissingStateDefaults([row(), row({ postalPrefix: "160" })])).toEqual([]);
    expect(findMissingStateDefaults([
      row({ originWarehouseId: 1, postalPrefix: "160" }),
    ])).toEqual(["PA at warehouse 1 has a ZIP override but no statewide fallback rate"]);
  });
});
