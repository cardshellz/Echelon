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
    destinationZone: "US-PA",
    destinationRegion: "PA",
    postalPrefix: null,
    minWeightGrams: 0,
    maxWeightGrams: 1000,
    rateCents: 800,
    ...overrides,
  };
}

describe("rate table lifecycle analysis", () => {
  it("blocks an empty table", () => {
    const result = analyzeRateTable([], "state_zip");

    expect(result.canActivate).toBe(false);
    expect(result.errors).toContain("The table has no rate rows.");
  });

  it("blocks missing, overlapping, and discontinuous weight coverage", () => {
    const result = analyzeRateTable([
      row({ minWeightGrams: 100, maxWeightGrams: 500 }),
      row({ minWeightGrams: 500, maxWeightGrams: 700 }),
      row({ minWeightGrams: 900, maxWeightGrams: 1200 }),
    ], "state_zip");

    expect(result.errors).toEqual(expect.arrayContaining([
      "PA statewide has no rate from 0g to 99g.",
      "PA statewide has overlapping weight bands 100-500g and 500-700g.",
      "PA statewide has no rate from 701g to 899g.",
    ]));
  });

  it("blocks ZIP overrides without a statewide fallback", () => {
    const result = analyzeRateTable([
      row({ destinationZone: "US-PA-ZIP-191", postalPrefix: "191" }),
    ], "state_zip");

    expect(result.canActivate).toBe(false);
    expect(result.errors).toContain("PA has a ZIP override but no statewide fallback rate");
  });

  it("blocks legacy rows in a state and ZIP table", () => {
    const result = analyzeRateTable([
      row({ destinationZone: "ZONE-4", destinationRegion: null }),
    ], "state_zip");

    expect(result.canActivate).toBe(false);
    expect(result.errors).toContain("1 rate row is not mapped to a state or ZIP area.");
  });

  it("warns about uncovered regions but permits explicit activation", () => {
    const result = analyzeRateTable([row()], "state_zip");

    expect(result.canActivate).toBe(true);
    expect(result.warnings[0]).toContain("No statewide rates are configured for:");
    expect(result.coverage.stateCount).toBe(1);
    expect(result.coverage.missingRegions).not.toContain("PA");
  });

  it("has no geography warning when all US postal regions have a fallback", () => {
    const rows = US_POSTAL_REGIONS.map((region) => row({
      destinationZone: `US-${region}`,
      destinationRegion: region,
    }));

    const result = analyzeRateTable(rows, "state_zip");

    expect(result.canActivate).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.coverage.stateCount).toBe(US_POSTAL_REGIONS.length);
  });
});

describe("rate table lifecycle transitions", () => {
  it("only activates and deletes drafts", () => {
    expect(canActivateRateTable("draft")).toBe(true);
    expect(canActivateRateTable("active")).toBe(false);
    expect(canDeleteRateTable("draft")).toBe(true);
    expect(canDeleteRateTable("retired")).toBe(false);
  });

  it("retires active or superseded tables", () => {
    expect(canRetireRateTable("active")).toBe(true);
    expect(canRetireRateTable("superseded")).toBe(true);
    expect(canRetireRateTable("draft")).toBe(false);
  });
});
