import { describe, expect, it } from "vitest";
import {
  buildMillsToRoundedCents,
  normalizeBuildLotCosts,
} from "../../infrastructure/build.repository";

function lot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    unit_cost_cents: 0,
    po_unit_cost_cents: 0,
    packaging_cost_cents: 0,
    landed_cost_cents: 0,
    total_unit_cost_cents: 0,
    unit_cost_mills: 0,
    po_unit_cost_mills: 0,
    packaging_cost_mills: 0,
    landed_cost_mills: 0,
    total_unit_cost_mills: 0,
    ...overrides,
  };
}

describe("build source-lot cost normalization", () => {
  it("preserves legacy cent-only lot value when exact mill columns are empty", () => {
    const result = normalizeBuildLotCosts(lot({
      unit_cost_cents: 123,
      po_unit_cost_cents: 100,
      packaging_cost_cents: 10,
      landed_cost_cents: 13,
      total_unit_cost_cents: 123,
    }));

    expect(result).toEqual({
      poMills: BigInt(10000),
      packagingMills: BigInt(1000),
      landedMills: BigInt(1300),
      totalMills: BigInt(12300),
    });
  });

  it("prefers exact mill values over rounded compatibility cents", () => {
    const result = normalizeBuildLotCosts(lot({
      unit_cost_cents: 124,
      po_unit_cost_cents: 101,
      packaging_cost_cents: 10,
      landed_cost_cents: 13,
      total_unit_cost_cents: 124,
      unit_cost_mills: 12345,
      po_unit_cost_mills: 10045,
      packaging_cost_mills: 1000,
      landed_cost_mills: 1300,
      total_unit_cost_mills: 12345,
    }));

    expect(result.totalMills).toBe(BigInt(12345));
    expect(result.poMills).toBe(BigInt(10045));
  });

  it("rejects negative legacy costs before inventory can be posted", () => {
    expect(() => normalizeBuildLotCosts(lot({
      total_unit_cost_cents: -1,
      unit_cost_cents: -1,
    }))).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE_LOT_COST" }));
  });

  it("rounds compatibility cents deterministically while exact mills remain authoritative", () => {
    expect(buildMillsToRoundedCents(BigInt(149))).toBe(BigInt(1));
    expect(buildMillsToRoundedCents(BigInt(150))).toBe(BigInt(2));
  });
});
