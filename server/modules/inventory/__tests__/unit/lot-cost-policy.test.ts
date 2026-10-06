import { describe, expect, it } from "vitest";
import { normalizeLotCosts, recordedUnitCostMills, lotCostNeedsReview } from "../../domain/lot-cost";

const exact = { id: 1,cost_precision_version: 1,cost_provisional: 0,qty_received: 4,
  unit_cost_mills: "149",total_unit_cost_mills: "149",po_unit_cost_mills: "100",packaging_cost_mills: "20",landed_cost_mills: "29",
  unit_cost_cents: 1,total_unit_cost_cents: 1,po_unit_cost_cents: 1,packaging_cost_cents: 0,landed_cost_cents: 0 };

describe("inventory cost evidence policy", () => {
  it("keeps an authoritative zero despite stale positive compatibility mirrors", () => {
    const zero = { ...exact,unit_cost_mills: 0,total_unit_cost_mills: 0,po_unit_cost_mills: 0,packaging_cost_mills: 0,landed_cost_mills: 0,
      unit_cost_cents: 999,total_unit_cost_cents: 999,po_unit_cost_cents: 999 };
    expect(normalizeLotCosts(zero)).toEqual({ totalMills: BigInt(0),poMills: BigInt(0),packagingMills: BigInt(0),landedMills: BigInt(0) });
    expect(recordedUnitCostMills(zero)).toBe(BigInt(0));
    expect(lotCostNeedsReview(zero)).toBe(false);
  });
  it("preserves exact legacy cent-only costs until their precision is explicitly owned", () => {
    expect(normalizeLotCosts({ ...exact,cost_precision_version: 0,unit_cost_mills: 0,total_unit_cost_mills: 0,
      po_unit_cost_mills: 0,packaging_cost_mills: 0,landed_cost_mills: 0,
      unit_cost_cents: 123,total_unit_cost_cents: 123,po_unit_cost_cents: 100,packaging_cost_cents: 10,landed_cost_cents: 13 }))
      .toEqual({ totalMills: BigInt(12300),poMills: BigInt(10000),packagingMills: BigInt(1000),landedMills: BigInt(1300) });
  });
  it.each(["unit_cost_mills","total_unit_cost_mills","po_unit_cost_mills","packaging_cost_mills","landed_cost_mills"] as const)
    ("rejects negative %s before a mirror can hide it", field => {
      expect(()=>normalizeLotCosts({ ...exact,[field]: -500,unit_cost_cents: 100,total_unit_cost_cents: 100 }))
        .toThrowError(expect.objectContaining({ code: "INVALID_SOURCE_LOT_COST" }));
    });
  it.each(["1.0",1.5,true,Number.MAX_SAFE_INTEGER+1,"9223372036854775808"])("rejects unsupported raw amount %s", amount => {
    expect(()=>normalizeLotCosts({ ...exact,unit_cost_mills: amount })).toThrow();
  });
  it("requires authoritative components to reconcile rather than manufacturing a residual", () => {
    expect(()=>normalizeLotCosts({ ...exact,po_unit_cost_mills: 1 })).toThrow(/components/);
  });
  it("keeps a legacy total while marking an unproven residual component for review", () => {
    const legacy = { ...exact, cost_precision_version: 0, po_unit_cost_mills: "149" };
    expect(normalizeLotCosts(legacy)).toEqual({ totalMills: BigInt(149), poMills: BigInt(100), packagingMills: BigInt(20), landedMills: BigInt(29) });
    expect(lotCostNeedsReview(legacy)).toBe(true);
  });
  it("distinguishes unknown legacy zero, missing basis and estimated cost from a confirmed zero", () => {
    expect(lotCostNeedsReview({ ...exact,cost_provisional: 1 })).toBe(true);
    expect(lotCostNeedsReview({ ...exact,qty_received: 0 })).toBe(true);
    expect(lotCostNeedsReview({ cost_precision_version: 0,qty_received: 4 })).toBe(true);
    expect(lotCostNeedsReview(exact)).toBe(false);
  });
});
