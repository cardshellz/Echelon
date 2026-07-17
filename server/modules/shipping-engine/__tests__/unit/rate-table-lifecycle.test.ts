import { describe, expect, it } from "vitest";
import {
  analyzeRateTable,
  canActivateRateTable,
  canDeleteRateTable,
  canRetireRateTable,
} from "../../domain/rate-table-lifecycle";
import type { RateTableImportRow } from "../../domain/rate-table-import";
import { US_POSTAL_REGIONS } from "../../domain/us-geography";

function row(overrides: Partial<RateTableImportRow> = {}): RateTableImportRow {
  return {
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minMeasure: 0,
    maxMeasure: 1000,
    maxShipmentWeightGrams: null,
    rateCents: 800,
    ...overrides,
  };
}

describe("rate table lifecycle analysis", () => {
  it("blocks an empty table", () => {
    const result = analyzeRateTable([], "shipment_weight");
    expect(result.canActivate).toBe(false);
    expect(result.errors).toContain("The table has no rate rows.");
  });

  it("blocks missing, overlapping, and discontinuous parcel coverage", () => {
    const result = analyzeRateTable([
      row({ minMeasure: 100, maxMeasure: 500 }),
      row({ minMeasure: 500, maxMeasure: 700 }),
      row({ minMeasure: 900, maxMeasure: 1200 }),
    ], "shipment_weight");
    expect(result.errors).toEqual(expect.arrayContaining([
      "PA statewide has no rate from 0g to 99g.",
      "PA statewide has overlapping bands 100g-500g and 500g-700g.",
      "PA statewide has no rate from 701g to 899g.",
    ]));
  });

  it("starts pallet coverage at one and permits a freight weight ceiling", () => {
    const result = analyzeRateTable([
      row({ minMeasure: 1, maxMeasure: 2, maxShipmentWeightGrams: 500_000 }),
      row({ minMeasure: 3, maxMeasure: 4, maxShipmentWeightGrams: 1_000_000 }),
    ], "pallet_count");
    expect(result.canActivate).toBe(true);
  });

  it("blocks freight-only ceilings on parcel tables", () => {
    const result = analyzeRateTable([
      row({ maxShipmentWeightGrams: 500_000 }),
    ], "shipment_weight");
    expect(result.canActivate).toBe(false);
    expect(result.errors[0]).toContain("freight weight ceiling");
  });

  it("blocks ZIP overrides without a statewide fallback", () => {
    const result = analyzeRateTable([row({ postalPrefix: "191" })], "shipment_weight");
    expect(result.canActivate).toBe(false);
  });

  it("warns about uncovered regions but permits activation", () => {
    const result = analyzeRateTable([row()], "shipment_weight");
    expect(result.canActivate).toBe(true);
    expect(result.coverage.stateCount).toBe(1);
  });

  it("has no geography warning when every US postal region has a fallback", () => {
    const rows = US_POSTAL_REGIONS.map((region) => row({ destinationRegion: region }));
    const result = analyzeRateTable(rows, "shipment_weight");
    expect(result.canActivate).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("rate table lifecycle transitions", () => {
  it("keeps draft-first lifecycle rules", () => {
    expect(canActivateRateTable("draft")).toBe(true);
    expect(canDeleteRateTable("draft")).toBe(true);
    expect(canRetireRateTable("active")).toBe(true);
    expect(canRetireRateTable("superseded")).toBe(true);
  });
});
