import { describe, expect, it } from "vitest";
import { SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS, shipmentAllocationEvidenceSchema } from "@shared/procurement/shipment-allocation";
import {
  allocateCentsFromNumericBasis, allocateShipmentCents, buildShipmentAllocationBasis, buildShipmentAllocationEvidence,
  projectShipmentProductValue, resolveShipmentAllocationMethod, resolveShipmentProductValue, roundShipmentRatioToInteger,
  shipmentAllocationBasisMatches, shipmentAllocationEvidenceMatches, storedBasisMirror, type ShipmentAllocationBasisLine,
} from "../../domain/shipment-allocation-basis";

const line: ShipmentAllocationBasisLine = {
  lineId: 11, qtyShipped: 100, totalVolumeCbm: "0.100001", totalWeightKg: "20.125", chargeableWeightKg: "30.375",
  poLineId: 101, poOrderQty: 100, poTotalProductCostCents: "10000", poCurrency: "USD",
};
const valueLine = (lineId: number, total: number | string, ordered = 1, shipped = 1): ShipmentAllocationBasisLine => ({
  ...line, lineId, poLineId: lineId + 100, poOrderQty: ordered, qtyShipped: shipped, poTotalProductCostCents: total,
});
const amounts = (lines: ShipmentAllocationBasisLine[], cents: number) =>
  allocateShipmentCents(cents, buildShipmentAllocationBasis(lines, "by_value")).map((entry) => entry.allocatedCents);

describe("shared shipment allocation basis", () => {
  it.each([
    ["duty", "by_weight", "by_volume", "by_value", "cost_type_override"],
    ["brokerage", null, "by_volume", "by_line_count", "cost_type_override"],
    ["freight", "by_weight", "by_volume", "by_weight", "cost_row"],
    ["freight", null, "by_chargeable_weight", "by_chargeable_weight", "shipment_default"],
    ["freight", null, null, "by_volume", "fallback_default"],
  ])("resolves %s policy in the existing order", (type, method, defaultMethod, expected, source) => {
    expect(resolveShipmentAllocationMethod(type!, method, defaultMethod)).toEqual({ method: expected, source });
  });

  it("allocates subcent products from recorded product totals, not rounded unit mirrors", () => {
    const sources = [valueLine(11, 490, 1000, 1000), valueLine(12, 500, 1000, 1000)];
    expect(amounts(sources, 990)).toEqual([490, 500]);
    const basis = buildShipmentAllocationBasis(sources, "by_value");
    expect(basis).toMatchObject({ values: [{ lineId: 11, basis: 490 }, { lineId: 12, basis: 500 }], basisTotal: 990, usedFallback: false });
    expect(buildShipmentAllocationEvidence(basis, 11)).toEqual({ version: 2, method: "by_value", lineId: 11,
      source: { kind: "po_product_total", poLineId: 111, orderQty: 1000, qtyShipped: 1000, totalProductCostCents: "490", currency: "USD" },
      rawRatio: { numerator: "490", denominator: "1" }, ratio: { numerator: "490", denominator: "1" },
      totalRatio: { numerator: "990", denominator: "1" }, usedFallback: false });
  });

  it("preserves repeating partial-shipment values without rounding cents or mills first", () => {
    const sources = [valueLine(11, 1, 3), valueLine(12, 1, 7)];
    const basis = buildShipmentAllocationBasis(sources, "by_value");
    expect(basis.totalRatio).toEqual({ numerator: "10", denominator: "21" });
    expect(basis.values.map((entry) => entry.ratio)).toEqual([{ numerator: "1", denominator: "3" }, { numerator: "1", denominator: "7" }]);
    expect(allocateShipmentCents(100, basis).map((entry) => entry.allocatedCents)).toEqual([70, 30]);
    expect(allocateShipmentCents(1, basis).map((entry) => entry.allocatedCents)).toEqual([1, 0]);
  });

  it("uses integer cross-products where independently rounded unit mills would change a penny", () => {
    expect(amounts([valueLine(11, 1, 3), valueLine(12, 1, 4)], 7)).toEqual([4, 3]);
    const source = resolveShipmentProductValue(valueLine(11, 1, 3));
    expect(source.ratio).toEqual({ numerator: "1", denominator: "3" });
    expect(roundShipmentRatioToInteger(source.ratio, 100)).toBe(33);
  });

  it("handles exact integer products beyond Number safe multiplication and conserves the maximum charge", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const sources = [valueLine(11, max, 2, 3), valueLine(12, max, 4, 3)];
    const basis = buildShipmentAllocationBasis(sources, "by_value");
    expect(basis.values[0].ratio).toEqual({ numerator: (BigInt(max) * BigInt(3)).toString(), denominator: "2" });
    const allocated = allocateShipmentCents(max, basis);
    expect(allocated.reduce((sum, entry) => sum + BigInt(entry.allocatedCents), BigInt(0))).toBe(BigInt(max));
    expect(allocated.map((entry) => entry.allocatedCents)).toEqual([6004799503160661, 3002399751580330]);
    expect(storedBasisMirror(basis.basisTotal)).toBeNull();
  });

  it("breaks exact remainder ties by immutable line ID, independent of input order", () => {
    const sources = [valueLine(30, 1, 3), valueLine(10, 1, 3), valueLine(20, 1, 3)];
    const allocated = (rows: ShipmentAllocationBasisLine[]) => allocateShipmentCents(2, buildShipmentAllocationBasis(rows, "by_value"))
      .map(({ lineId, allocatedCents }) => ({ lineId, allocatedCents })).sort((a, b) => a.lineId - b.lineId);
    expect(allocated(sources)).toEqual([{ lineId: 10, allocatedCents: 1 }, { lineId: 20, allocatedCents: 1 }, { lineId: 30, allocatedCents: 0 }]);
    expect(allocated([...sources].reverse())).toEqual(allocated(sources));
  });

  it("keeps the established all-known-zero value fallback explicit", () => {
    const basis = buildShipmentAllocationBasis([valueLine(11, 0), valueLine(12, 0)], "by_value");
    expect(basis).toMatchObject({ usedFallback: true, rawBasisTotal: 0, basisTotal: 2,
      values: [{ lineId: 11, basis: 1, rawRatio: { numerator: "0", denominator: "1" } }, { lineId: 12, basis: 1 }] });
    expect(allocateShipmentCents(3, basis).map((entry) => entry.allocatedCents)).toEqual([2, 1]);
    expect(buildShipmentAllocationEvidence(basis, 11).usedFallback).toBe(true);
  });

  it("keeps a known zero line at zero when another line has positive product value", () => {
    expect(amounts([valueLine(11, 0), valueLine(12, 5)], 7)).toEqual([0, 7]);
  });

  it.each([null, undefined, "", " ", "-1", "0.5", "NaN", "Infinity", "9007199254740993"])("rejects missing or invalid product total %s instead of treating it as zero", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, poTotalProductCostCents: value }], "by_value")).toThrow();
  });
  it.each([null, undefined, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects missing or invalid ordered pieces %s", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, poOrderQty: value }], "by_value")).toThrow();
  });
  it.each([null, undefined, "EUR", "usd"])("rejects unsupported or missing PO currency %s without inventing FX", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, poCurrency: value }], "by_value")).toThrow(/USD/);
  });
  it.each([null, undefined, 0, -1])("requires a real source PO line %s", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, poLineId: value }], "by_value")).toThrow();
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid shipped pieces %s", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, qtyShipped: value }], "by_value")).toThrow();
  });

  it("does not promote old numeric-only or stale source evidence to current authority", () => {
    const basis = buildShipmentAllocationBasis([line], "by_value");
    const saved = buildShipmentAllocationEvidence(basis, line.lineId);
    expect(shipmentAllocationEvidenceMatches(saved, basis, line.lineId)).toBe(true);
    expect(shipmentAllocationEvidenceMatches(null, basis, line.lineId)).toBe(false);
    expect(shipmentAllocationEvidenceMatches({ version: 1, basis: 10000 }, basis, line.lineId)).toBe(false);
    // Same effective ratio, different commercial source still requires review.
    const revised = buildShipmentAllocationBasis([{ ...line, poOrderQty: 200, poTotalProductCostCents: 20000 }], "by_value");
    expect(shipmentAllocationEvidenceMatches(saved, revised, line.lineId)).toBe(false);
    expect(shipmentAllocationEvidenceMatches({ ...saved, unexpected: true }, basis, line.lineId)).toBe(false);
  });

  it("preserves six-decimal dimensions and their existing legacy comparisons", () => {
    const basis = buildShipmentAllocationBasis([line, { ...line, lineId: 12, totalVolumeCbm: "0.200002" }], "by_volume");
    expect(basis.basisTotal).toBe(0.300003);
    expect(shipmentAllocationBasisMatches("0.300003", basis.basisTotal)).toBe(true);
    expect(shipmentAllocationBasisMatches("0.300002", basis.basisTotal)).toBe(false);
    expect(allocateShipmentCents(9, basis).map((entry) => entry.allocatedCents)).toEqual([3, 6]);
    expect(buildShipmentAllocationEvidence(basis, 11).source).toEqual({ kind: "dimension", field: "totalVolumeCbm", value: "0.100001" });
  });
  it.each(["by_volume", "by_weight", "by_chargeable_weight"])("retains missing dimensional evidence for %s", (method) => {
    const basis = buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null }], method);
    expect(basis).toMatchObject({ usedFallback: false, basisTotal: 0, missingDimensionLineIds: [11] });
    expect(() => allocateShipmentCents(100, basis)).toThrow(/positive physical allocation basis/);
  });
  it("does not require PO source fields for line-count or dimension allocation", () => {
    const source = { lineId: 11, qtyShipped: 0, totalVolumeCbm: "1", totalWeightKg: "1", chargeableWeightKg: "1" };
    expect(buildShipmentAllocationBasis([source], "by_line_count").basisTotal).toBe(1);
    expect(buildShipmentAllocationBasis([source], "by_volume").basisTotal).toBe(1);
  });
  it("does not treat a blank stored numeric basis as a confirmed zero", () => {
    expect(shipmentAllocationBasisMatches(null, 0)).toBe(false);
    expect(shipmentAllocationBasisMatches("", 0)).toBe(false);
    expect(shipmentAllocationBasisMatches("0.000000", 0)).toBe(true);
  });
  it("retains dimensional exact-number DTO validation", () => {
    expect(() => buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: "9007199254.740991" }], "by_volume")).toThrow(/represented exactly/);
    expect(() => buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: "100000000000000" },
      { ...line, lineId: 12, totalVolumeCbm: "0.000001" }], "by_volume")).toThrow(/represented exactly/);
  });
  it("constructs exact decimal denominators across supported numeric scales", () => {
    const smallest = buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: "5e-324" }], "by_volume");
    expect(smallest.values[0].ratio).toEqual({ numerator: "1", denominator: `2${"0".repeat(323)}` });
    expect(allocateShipmentCents(1, smallest)[0].allocatedCents).toBe(1);
    const integer = buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: "20" }], "by_volume");
    expect(integer.values[0].ratio).toEqual({ numerator: "20", denominator: "1" });
  });
  it("rejects unsupported methods and duplicate source lines", () => {
    expect(() => resolveShipmentAllocationMethod("freight", "unknown", null)).toThrow(/Unsupported/);
    expect(() => buildShipmentAllocationBasis([line, line], "by_line_count")).toThrow(/unique/);
  });

  it("preserves numeric allocator entry semantics using the exact allocator", () => {
    expect(allocateCentsFromNumericBasis(2, [{ lineId: 3, basis: 1 }, { lineId: 1, basis: 1 }, { lineId: 2, basis: 1 }])
      .map((entry) => entry.allocatedCents)).toEqual([0, 1, 1]);
    expect(allocateCentsFromNumericBasis(0, [])).toEqual([]);
    expect(allocateCentsFromNumericBasis(100, [{ lineId: 1, basis: 0 }, { lineId: 2, basis: 1 }]).map(row => row.allocatedCents)).toEqual([0, 100]);
    expect(() => allocateCentsFromNumericBasis(1, [{ lineId: 1, basis: 0 }])).toThrow(/positive/);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsupported charge %s", (value) => {
    expect(() => allocateShipmentCents(value, buildShipmentAllocationBasis([line], "by_value"))).toThrow();
  });
  it("validates exact basis consistency and rounds only compatibility displays", () => {
    const basis = buildShipmentAllocationBasis([valueLine(11, 1, 3)], "by_value");
    expect(() => allocateShipmentCents(1, { ...basis, totalRatio: { numerator: "1", denominator: "2" } })).toThrow(/does not match/);
    expect(storedBasisMirror(1 / 3)).toBe("0.333333");
    expect(storedBasisMirror(99999999.999999)).toBe("99999999.999999");
    expect(storedBasisMirror(100000000)).toBeNull();
    expect(storedBasisMirror(NaN)).toBeNull();
    expect(roundShipmentRatioToInteger({ numerator: "1", denominator: "2" })).toBe(1);
    expect(() => roundShipmentRatioToInteger({ numerator: "9007199254740993", denominator: "1" })).toThrow(/range/);
  });

  it("bounds persisted integer evidence before BigInt parsing", () => {
    const basis = buildShipmentAllocationBasis([line], "by_value");
    const saved = buildShipmentAllocationEvidence(basis, line.lineId);
    const oversized = { numerator: "1".repeat(SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS + 1), denominator: "1" };
    expect(shipmentAllocationEvidenceSchema.safeParse({ ...saved, totalRatio: oversized }).success).toBe(false);
    expect(shipmentAllocationEvidenceMatches({ ...saved, totalRatio: oversized }, basis, line.lineId)).toBe(false);
    expect(() => roundShipmentRatioToInteger(oversized)).toThrow(/bounded/);
    expect(() => buildShipmentAllocationBasis([{ ...line, poOrderQty: 2147483648 }], "by_value")).toThrow(/database integer/);
    expect(() => buildShipmentAllocationBasis([{ ...line, lineId: 2147483648 }], "by_value")).toThrow(/database integer/);
    expect(shipmentAllocationEvidenceSchema.safeParse({ ...saved, source: { ...saved.source, totalProductCostCents: "9007199254740992" } }).success).toBe(false);
  });

  it("projects snapshot totals and unit displays without intermediate cents or mills rounding", () => {
    const basis = buildShipmentAllocationBasis([valueLine(11, 1, 3, 2)], "by_value");
    const evidence = buildShipmentAllocationEvidence(basis, 11);
    const before = structuredClone(evidence);
    expect(projectShipmentProductValue(evidence, 1)).toEqual({ productTotalCents: 1, poUnitCostCents: 0,
      poUnitCostMills: 33, totalLandedCostCents: 2, landedUnitCostCents: 1, landedUnitCostMills: 83 });
    expect(evidence).toEqual(before);
    const subcent = buildShipmentAllocationEvidence(buildShipmentAllocationBasis([valueLine(11, 490, 1000, 1000)], "by_value"), 11);
    expect(projectShipmentProductValue(subcent, 490)).toEqual({ productTotalCents: 490, poUnitCostCents: 0,
      poUnitCostMills: 49, totalLandedCostCents: 980, landedUnitCostCents: 1, landedUnitCostMills: 98 });
  });

  it("validates frozen product projection source rather than trusting a forged ratio", () => {
    const evidence = buildShipmentAllocationEvidence(buildShipmentAllocationBasis([valueLine(11, 1, 3)], "by_value"), 11);
    expect(() => projectShipmentProductValue({ ...evidence, rawRatio: { numerator: "1", denominator: "2" } }, 0)).toThrow(/reconcile/);
    const dimension = buildShipmentAllocationEvidence(buildShipmentAllocationBasis([line], "by_volume"), 11);
    expect(() => projectShipmentProductValue(dimension, 0)).toThrow(/product-value evidence/);
    expect(() => projectShipmentProductValue(evidence, -1)).toThrow(/nonnegative/);
    expect(() => projectShipmentProductValue(evidence, 0.5)).toThrow(/integer/);
    const large = buildShipmentAllocationEvidence(buildShipmentAllocationBasis([valueLine(11, Number.MAX_SAFE_INTEGER)], "by_value"), 11);
    expect(() => projectShipmentProductValue(large, 1)).toThrow(/range/);
  });
});
