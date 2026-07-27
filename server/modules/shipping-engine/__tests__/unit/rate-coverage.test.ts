import { describe, expect, it } from "vitest";
import {
  analyzeRateCoverage,
  findStaleDraftCoverageErrors,
  type RateCoverageCandidate,
} from "../../domain/rate-coverage";
import type { RateTableImportRow } from "../../domain/rate-table-import";

function coverage(
  overrides: Partial<RateCoverageCandidate> = {},
): RateCoverageCandidate {
  return {
    destinationGroupId: 1,
    destinationGroupLockVersion: 1,
    name: "Pennsylvania",
    originWarehouseId: null,
    availability: "offered",
    destinations: [{
      destinationCountry: "US",
      destinationRegion: "PA",
      postalPrefix: null,
    }],
    ...overrides,
  };
}

function row(overrides: Partial<RateTableImportRow> = {}): RateTableImportRow {
  return {
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minMeasure: 0,
    maxMeasure: 454,
    maxShipmentWeightGrams: null,
    chargeModel: "fixed_band",
    rateCents: 899,
    perStartedPoundCents: null,
    ...overrides,
  };
}

describe("rate coverage manifest analysis", () => {
  it("accepts priced offered coverage and empty not-offered coverage", () => {
    const result = analyzeRateCoverage([
      coverage(),
      coverage({
        destinationGroupId: 2,
        name: "Alaska",
        availability: "not_offered",
        destinations: [{
          destinationCountry: "US",
          destinationRegion: "AK",
          postalPrefix: null,
        }],
      }),
    ], [row()]);

    expect(result).toEqual({
      errors: [],
      offeredCount: 1,
      notOfferedCount: 1,
    });
  });

  it("rejects an offered destination without a rate", () => {
    const result = analyzeRateCoverage([coverage()], []);

    expect(result.errors).toContain(
      "Pennsylvania is offered but has no rates for US PA.",
    );
  });

  it("rejects a not-offered destination that still has a rate", () => {
    const result = analyzeRateCoverage([
      coverage({ availability: "not_offered" }),
    ], [row()]);

    expect(result.errors).toContain(
      "Pennsylvania is not offered but still has rates for US PA.",
    );
  });

  it("rejects duplicate destination ownership at the same warehouse scope", () => {
    const result = analyzeRateCoverage([
      coverage(),
      coverage({
        destinationGroupId: 2,
        name: "Northeast",
      }),
    ], [row()]);

    expect(result.errors).toContain(
      "US PA is assigned to both Pennsylvania and Northeast for the same warehouse scope.",
    );
  });

  it("allows the same destination at distinct warehouse scopes", () => {
    const result = analyzeRateCoverage([
      coverage(),
      coverage({
        destinationGroupId: 2,
        name: "Pennsylvania from LEON",
        originWarehouseId: 1,
      }),
    ], [
      row(),
      row({ originWarehouseId: 1 }),
    ]);

    expect(result.errors).toEqual([]);
  });

  it("rejects malformed destination members", () => {
    const result = analyzeRateCoverage([
      coverage({
        destinations: [{
          destinationCountry: "US",
          destinationRegion: null,
          postalPrefix: "191",
        }],
      }),
    ], []);

    expect(result.errors).toContain(
      "Pennsylvania: a postal-prefix destination also requires a region.",
    );
  });
});

describe("stale draft coverage analysis", () => {
  const frozenCoverage = {
    destinationGroupId: 7,
    destinationGroupLockVersion: 3,
    name: "Lower 48",
  };

  it("accepts every warehouse scope frozen from the current group version", () => {
    expect(findStaleDraftCoverageErrors(
      [frozenCoverage, { ...frozenCoverage }],
      [{
        id: 7,
        name: "Lower 48",
        status: "active",
        lockVersion: 3,
      }],
    )).toEqual([]);
  });

  it("reports a changed group once when several warehouse scopes use it", () => {
    expect(findStaleDraftCoverageErrors(
      [frozenCoverage, { ...frozenCoverage }],
      [{
        id: 7,
        name: "Lower 48",
        status: "active",
        lockVersion: 4,
      }],
    )).toEqual([
      "Lower 48 uses an older destination definition. Use the current destinations and save the draft.",
    ]);
  });

  it("blocks retired, missing, and identity-less destination groups", () => {
    expect(findStaleDraftCoverageErrors(
      [
        frozenCoverage,
        {
          destinationGroupId: 8,
          destinationGroupLockVersion: 1,
          name: "Alaska",
        },
        {
          destinationGroupId: null,
          destinationGroupLockVersion: null,
          name: "Military mail",
        },
      ],
      [{
        id: 7,
        name: "Lower 48",
        status: "retired",
        lockVersion: 3,
      }],
    )).toEqual([
      "Lower 48 is no longer an active destination group. Refresh the draft.",
      "Alaska is no longer an active destination group. Refresh the draft.",
      "Military mail has no reusable destination-group identity. Save the draft again.",
    ]);
  });
});
