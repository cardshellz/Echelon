import { describe, expect, it } from "vitest";
import { computeShipmentLinePhysicalTotals, validateShipmentPhysicalTotals } from "../../shipment-line-physical-values";

const physical = { qtyShipped: 501, cartonCount: 11, weightKg: "2", lengthCm: "10", widthCm: "20", heightCm: "30" };

describe("explicit shipment measurement basis", () => {
  it("uses declared piece measurements even when cartons are recorded", () => {
    const line = { ...physical, dimensionBasis: "piece" };
    const before = structuredClone(line);
    expect(computeShipmentLinePhysicalTotals(line)).toEqual({
      totalWeightKg: "1002.000", totalVolumeCbm: "3.006000", chargeableWeightKg: "1002.000",
    });
    expect(line).toEqual(before);
  });

  it("uses declared carton measurements without converting the shipped pieces", () => {
    const line = { ...physical, dimensionBasis: "carton" };
    expect(computeShipmentLinePhysicalTotals(line)).toEqual({
      totalWeightKg: "22.000", totalVolumeCbm: "0.066000", chargeableWeightKg: "22.000",
    });
    expect(line.qtyShipped).toBe(501);
  });

  it.each([undefined, null])("rejects per-carton measurements without actual cartons (%s)", (cartonCount) => {
    expect(() => computeShipmentLinePhysicalTotals({ ...physical, dimensionBasis: "carton", cartonCount }))
      .toThrow(expect.objectContaining({ details: { code: "SHIPMENT_LINE_CARTON_COUNT_REQUIRED" } }));
  });

  it("does not silently switch a cleared carton count to a piece multiplier", () => {
    expect(() => computeShipmentLinePhysicalTotals({ ...physical, dimensionBasis: "carton", cartonCount: null,
      weightKg: null, lengthCm: null, widthCm: null, heightCm: null }))
      .toThrow(/number of shipping cartons/);
  });

  it.each([null, undefined])("retains an untouched legacy calculation (%s)", (dimensionBasis) => {
    expect(computeShipmentLinePhysicalTotals({ ...physical, dimensionBasis }).totalWeightKg).toBe("22.000");
    expect(computeShipmentLinePhysicalTotals({ ...physical, dimensionBasis, cartonCount: null }).totalWeightKg).toBe("1002.000");
  });

  it("rejects unknown measurement bases instead of treating them as pieces", () => {
    expect(() => computeShipmentLinePhysicalTotals({ ...physical, dimensionBasis: "pack" }))
      .toThrow(expect.objectContaining({ details: { code: "SHIPMENT_LINE_INPUT_INVALID" } }));
  });

  it("checks saved physical totals against the declared basis", () => {
    const legacy = computeShipmentLinePhysicalTotals(physical);
    expect(() => validateShipmentPhysicalTotals([{ ...physical, ...legacy, dimensionBasis: "piece" }]))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ code: "SHIPMENT_LINE_TOTALS_REVIEW_REQUIRED" }) }));
    const selected = { ...physical, dimensionBasis: "piece" };
    expect(() => validateShipmentPhysicalTotals([{ ...selected, ...computeShipmentLinePhysicalTotals(selected) }])).not.toThrow();
  });
});
