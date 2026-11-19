import { describe, expect, it } from "vitest";
import { computeShipmentPhysicalTotals, summarizeShipmentPhysicalValues, shipmentPhysicalAllocationValue } from "../../shipment-physical-values";

const cartons = Object.freeze({ qtyShipped: 525000, cartonCount: 525, dimensionBasis: "carton",
  weightKg: "8.300", lengthCm: "41.00", widthCm: "18.00", heightCm: "22.00" });

describe("saved shipment measurements", () => {
  it("reproduces the saved carton-weight and CBM example exactly", () => {
    expect(computeShipmentPhysicalTotals(cartons)).toEqual({ totalWeightKg: "4357.500", totalVolumeCbm: "8.523900", chargeableWeightKg: "4357.500" });
    expect(summarizeShipmentPhysicalValues([cartons])).toEqual({ totalPieces: 525000, totalCartons: 525,
      totalWeightKg: "4357.500", totalVolumeCbm: "8.523900" });
  });
  it("never uses receive configuration or stale materialized totals as measurement authority", () => {
    const line = { ...cartons, unitsPerVariantSnapshot: 1000, totalWeightKg: "1", totalVolumeCbm: "999", chargeableWeightKg: "1" };
    const before = structuredClone(line);
    expect(computeShipmentPhysicalTotals({ ...line, unitsPerVariantSnapshot: 10000 } as typeof line))
      .toEqual(computeShipmentPhysicalTotals(cartons));
    expect(line).toEqual(before);
  });
  it("uses the recorded physical basis when pieces or carton counts change", () => {
    expect(computeShipmentPhysicalTotals({ ...cartons, qtyShipped: 1000000 })).toEqual(computeShipmentPhysicalTotals(cartons));
    expect(computeShipmentPhysicalTotals({ ...cartons, cartonCount: 1050 })).toMatchObject({ totalWeightKg: "8715.000", totalVolumeCbm: "17.047800" });
    expect(computeShipmentPhysicalTotals({ qtyShipped: 10, cartonCount: 2, dimensionBasis: "piece", weightKg: "0.002",
      lengthCm: "1", widthCm: "2", heightCm: "3" })).toEqual({ totalWeightKg: "0.020", totalVolumeCbm: "0.000060", chargeableWeightKg: "0.020" });
  });
  it("keeps missing measurements unknown to allocation rather than manufacturing a positive basis", () => {
    expect(computeShipmentPhysicalTotals({ qtyShipped: 800000, cartonCount: 80 })).toEqual({ totalWeightKg: "0.000", totalVolumeCbm: "0.000000", chargeableWeightKg: "0.000" });
  });
  it("requires both actual and volumetric inputs for chargeable-weight allocation", () => {
    expect(shipmentPhysicalAllocationValue({ ...cartons, lengthCm: null }, "by_chargeable_weight")).toBeNull();
    expect(shipmentPhysicalAllocationValue({ ...cartons, weightKg: null }, "by_chargeable_weight")).toBeNull();
    expect(shipmentPhysicalAllocationValue({ ...cartons, lengthCm: null }, "by_weight")).toBe("4357.500");
    expect(shipmentPhysicalAllocationValue({ ...cartons, weightKg: null }, "by_volume")).toBe("8.523900");
  });
  it("retains the recorded legacy basis until an explicit packing edit", () => {
    expect(computeShipmentPhysicalTotals({ ...cartons, dimensionBasis: null })).toEqual(computeShipmentPhysicalTotals(cartons));
    expect(computeShipmentPhysicalTotals({ qtyShipped: 10, cartonCount: null, weightKg: "1" })).toMatchObject({ totalWeightKg: "10.000" });
  });
  it.each([{ qtyShipped: 0 }, { qtyShipped: 1.5 }, { cartonCount: 0 }, { dimensionBasis: "pack" },
    { weightKg: "-1" }, { lengthCm: "1.001" }, { weightKg: "NaN" }, { widthCm: "Infinity" },
    { cartonCount: null }])("rejects invalid or ambiguous physical input %j", change => {
    expect(() => computeShipmentPhysicalTotals({ ...cartons, ...change })).toThrow();
  });
  it("bounds both individual physical columns and shipment aggregates", () => {
    expect(() => computeShipmentPhysicalTotals({ ...cartons, lengthCm: "999999.99", widthCm: "999999.99", heightCm: "999999.99" }))
      .toThrow(/supported column range/);
    expect(() => summarizeShipmentPhysicalValues([{ ...cartons, qtyShipped: 2147483647 }, cartons])).toThrow(/supported integer range/);
    expect(summarizeShipmentPhysicalValues([])).toEqual({ totalPieces: 0, totalCartons: 0, totalWeightKg: "0.000", totalVolumeCbm: "0.000000" });
  });
});
