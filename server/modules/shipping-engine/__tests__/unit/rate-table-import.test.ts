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
    minWeightGrams: 0,
    maxWeightGrams: 1000,
    rateCents: 899,
    ...overrides,
  };
}

describe("parseRateTableCsv", () => {
  it("parses state defaults and ZIP overrides without internal zones", () => {
    const result = parseRateTableCsv(
      "state,zip_prefix,min_lb,max_lb,rate_usd\nPA,,0,1,8.99\nPA,160,0,1,7.99\n",
    );
    expect(result.pricingMode).toBe("state_zip");
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        originWarehouseId: null,
        destinationCountry: "US",
        destinationRegion: "PA",
        postalPrefix: null,
        minWeightGrams: 0,
        maxWeightGrams: 454,
        rateCents: 899,
      },
      {
        originWarehouseId: null,
        destinationCountry: "US",
        destinationRegion: "PA",
        postalPrefix: "160",
        minWeightGrams: 0,
        maxWeightGrams: 454,
        rateCents: 799,
      },
    ]);
  });

  it("rejects zone-shaped files, invalid states, and invalid ZIP prefixes", () => {
    expect(parseRateTableCsv("zone,min_lb,max_lb,rate_usd\nUS-48,0,1,8.99\n").errors[0].message)
      .toContain("unrecognized header");
    const result = parseRateTableCsv(
      "state,zip_prefix,min_lb,max_lb,rate_usd\nAtlantis,,0,1,8.99\nPA,16A,0,1,7.99\n",
    );
    expect(result.errors.map((error) => error.message)).toEqual([
      'invalid US state or territory "Atlantis"',
      "zip_prefix must contain 1 to 5 digits",
    ]);
  });

  it("converts pounds and dollars with deterministic rounding", () => {
    const result = parseRateTableCsv("state,min_lb,max_lb,rate_usd\nPA,0,0.5,4.15\n");
    expect(result.rows[0].maxWeightGrams).toBe(Math.round(0.5 * GRAMS_PER_POUND));
    expect(result.rows[0].rateCents).toBe(Math.round(4.15 * CENTS_PER_USD));
  });

  it("accepts whole storage units in the grams dialect", () => {
    const result = parseRateTableCsv("state,min_g,max_g,rate_cents\nPA,0,1000,1599\n");
    expect(result.dialect).toBe("grams");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ minWeightGrams: 0, maxWeightGrams: 1000, rateCents: 1599 });
  });

  it("rejects fractional grams/cents and invalid numeric ranges", () => {
    expect(parseRateTableCsv("state,min_g,max_g,rate_cents\nPA,0,1000.5,899\n").errors[0].message)
      .toBe("min_g, max_g and rate_cents must be whole numbers");
    const result = parseRateTableCsv([
      "state,min_lb,max_lb,rate_usd",
      "PA,x,1,8.99",
      "PA,2,1,8.99",
      "PA,1,2,-1",
    ].join("\n"));
    expect(result.errors.map((error) => error.line)).toEqual([2, 3, 4]);
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
  it("accepts adjacent bands in one pricing area", () => {
    expect(findBandOverlaps([
      row({ minWeightGrams: 0, maxWeightGrams: 1000 }),
      row({ minWeightGrams: 1001, maxWeightGrams: 2000 }),
    ])).toEqual([]);
  });

  it("detects inclusive overlaps in the same geography and warehouse", () => {
    const errors = findBandOverlaps([
      row({ minWeightGrams: 0, maxWeightGrams: 1000 }),
      row({ minWeightGrams: 1000, maxWeightGrams: 2000 }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PA statewide");
  });

  it("allows identical bands for different ZIP prefixes or warehouses", () => {
    expect(findBandOverlaps([
      row({ postalPrefix: "160" }),
      row({ postalPrefix: "191" }),
      row({ originWarehouseId: 2 }),
    ])).toEqual([]);
  });
});

describe("findMissingStateDefaults", () => {
  it("accepts an override with a statewide fallback", () => {
    expect(findMissingStateDefaults([row(), row({ postalPrefix: "160" })])).toEqual([]);
  });

  it("requires the fallback in the same warehouse scope", () => {
    expect(findMissingStateDefaults([
      row({ originWarehouseId: 1, postalPrefix: "160" }),
    ])).toEqual(["PA at warehouse 1 has a ZIP override but no statewide fallback rate"]);
  });
});
