import { describe, expect, it } from "vitest";
import { buildShipmentAllocationBasis, resolveShipmentAllocationMethod, shipmentAllocationBasisMatches, type ShipmentAllocationBasisLine } from "../../domain/shipment-allocation-basis";

const line: ShipmentAllocationBasisLine = { lineId: 11, qtyShipped: 100, totalVolumeCbm: "0.100001", totalWeightKg: "20.125", chargeableWeightKg: "30.375", poUnitCostCents: "100" };

describe("shared shipment allocation basis", () => {
  it.each([
    ["duty", "by_weight", "by_volume", "by_value", "cost_type_override"],
    ["brokerage", null, "by_volume", "by_line_count", "cost_type_override"],
    ["freight", "by_weight", "by_volume", "by_weight", "cost_row"],
    ["freight", null, "by_chargeable_weight", "by_chargeable_weight", "shipment_default"],
    ["freight", null, null, "by_volume", "fallback_default"],
  ])("resolves %s policy in the same order as the owner", (type, method, defaultMethod, expected, source) => {
    expect(resolveShipmentAllocationMethod(type!, method, defaultMethod)).toEqual({ method: expected, source });
  });
  it("calculates exact PO value basis from cents and pieces", () => {
    expect(buildShipmentAllocationBasis([line, { ...line, lineId: 12, poUnitCostCents: "200" }], "by_value")).toMatchObject({ values: [{ lineId: 11, basis: 10000 }, { lineId: 12, basis: 20000 }], basisTotal: 30000, usedFallback: false });
  });
  it("preserves six-decimal volume without floating-point summation drift", () => {
    const basis = buildShipmentAllocationBasis([line, { ...line, lineId: 12, totalVolumeCbm: "0.200002" }], "by_volume");
    expect(basis.basisTotal).toBe(0.300003);
    expect(shipmentAllocationBasisMatches("0.300003", basis.basisTotal)).toBe(true);
    expect(shipmentAllocationBasisMatches("0.300002", basis.basisTotal)).toBe(false);
  });
  it.each(["by_volume", "by_weight", "by_chargeable_weight"])("retains missing dimensional evidence for %s", (method) => {
    const basis = buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null }], method);
    expect(basis).toMatchObject({ usedFallback: true, missingDimensionLineIds: [11] });
  });
  it("does not treat a blank stored basis as a confirmed zero", () => {
    expect(shipmentAllocationBasisMatches(null, 0)).toBe(false);
    expect(shipmentAllocationBasisMatches("", 0)).toBe(false);
    expect(shipmentAllocationBasisMatches("0.000000", 0)).toBe(true);
  });
  it("rejects decimal precision that the existing numeric allocation DTO cannot preserve", () => {
    expect(() => buildShipmentAllocationBasis([{ ...line, totalVolumeCbm: "9007199254.740991" }], "by_volume")).toThrow(/represented exactly/);
  });
  it("keeps the established all-zero value fallback explicit", () => {
    expect(buildShipmentAllocationBasis([{ ...line, poUnitCostCents: "0" }], "by_value")).toMatchObject({ usedFallback: true, rawBasisTotal: 0, basisTotal: 1, values: [{ lineId: 11, basis: 1 }] });
  });
  it.each(["-1", "NaN", "Infinity", "9007199254740993"])("rejects invalid or unsafe basis %s", (value) => {
    expect(() => buildShipmentAllocationBasis([{ ...line, poUnitCostCents: value }], "by_value")).toThrow();
  });
  it("rejects unsupported policy names and duplicate line identity", () => {
    expect(() => resolveShipmentAllocationMethod("freight", "unknown", null)).toThrow(/Unsupported/);
    expect(() => buildShipmentAllocationBasis([line, line], "by_line_count")).toThrow(/unique/);
  });
});
