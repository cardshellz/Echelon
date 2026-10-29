import { describe, expect, it } from "vitest";
import { shipmentMeasurementReviewRequestSchema, shipmentMeasurementApprovalSchema } from "@shared/procurement/shipment-measurement-correction";
import { shipmentCostUpdateInputSchema } from "@shared/procurement/shipment-cost-workflow";
import { ShipmentMeasurementCorrectionError } from "../../shipment-measurement-correction.repository";
import { classifyShipmentCostUpdateFailure } from "../../shipment-cost-update.commands";

const request = () => ({ sourceVersion: "a".repeat(64), reason: "Confirmed packing document measurements",
  lines: [{ lineId: 11, measurements: { cartonCount: 2, dimensionBasis: "carton", weightKg: "5.125", lengthCm: "30.25", widthCm: "10", heightCm: "10" } }] });
describe("measurement-only cost correction boundary", () => {
  it("retains the existing empty update contract and accepts a reviewed correction", () => {
    expect(shipmentCostUpdateInputSchema.parse({})).toEqual({});
    const measurementCorrection = { ...request(), previewVersion: "b".repeat(64), evidenceConfirmed: true };
    expect(shipmentCostUpdateInputSchema.parse({ measurementCorrection })).toEqual({ measurementCorrection });
  });
  it.each(["qtyShipped", "unitsPerVariantSnapshot", "purchaseOrderLineId", "productVariantId", "allocatedCostCents", "totalWeightKg", "totalVolumeCbm"])("rejects protected input %s", field => {
    const body = request();
    expect(shipmentMeasurementReviewRequestSchema.safeParse({ ...body, lines: [{ ...body.lines[0], measurements: { ...body.lines[0].measurements, [field]: 100 } }] }).success).toBe(false);
  });
  it.each(["-1", "NaN", "Infinity", "1e2", "1,000", "10000000", "5.1234"])("rejects weight %s without rounding or coercion", weightKg => {
    const body = request(); body.lines[0].measurements.weightKg = weightKg;
    expect(shipmentMeasurementReviewRequestSchema.safeParse(body).success).toBe(false);
  });
  it.each(["-1", "1000000", "1.234"])("rejects dimension %s", lengthCm => {
    const body = request(); body.lines[0].measurements.lengthCm = lengthCm;
    expect(shipmentMeasurementReviewRequestSchema.safeParse(body).success).toBe(false);
  });
  it("rejects duplicate line IDs, empty changes, missing cartons and an absent measurement basis", () => {
    const body = request();
    expect(shipmentMeasurementReviewRequestSchema.safeParse({ ...body, lines: [body.lines[0], body.lines[0]] }).success).toBe(false);
    expect(shipmentMeasurementReviewRequestSchema.safeParse({ ...body, lines: [] }).success).toBe(false);
    expect(shipmentMeasurementReviewRequestSchema.safeParse({ ...body, lines: [{ ...body.lines[0], measurements: { ...body.lines[0].measurements, cartonCount: null } }] }).success).toBe(false);
    expect(shipmentMeasurementReviewRequestSchema.safeParse({ ...body, lines: [{ ...body.lines[0], measurements: { ...body.lines[0].measurements, dimensionBasis: null } }] }).success).toBe(false);
  });
  it("permits known zeros and genuinely missing values, leaving allocation readiness to its existing owner", () => {
    const body = request();
    expect(shipmentMeasurementReviewRequestSchema.parse({ ...body, lines: [{ ...body.lines[0], measurements: { cartonCount: null, dimensionBasis: "piece", weightKg: "0", lengthCm: null, widthCm: null, heightCm: null } }] })).toBeTruthy();
  });
  it("requires reviewed impact and explicit evidence confirmation for an approval", () => {
    expect(shipmentMeasurementApprovalSchema.safeParse(request()).success).toBe(false);
    expect(shipmentMeasurementApprovalSchema.safeParse({ ...request(), previewVersion: "b".repeat(64), evidenceConfirmed: false }).success).toBe(false);
  });
  it("classifies stale and authority failures as definite rejections", () => {
    for (const status of [403, 409]) expect(classifyShipmentCostUpdateFailure(new ShipmentMeasurementCorrectionError("Review changed.", "SHIPMENT_MEASUREMENTS_STALE", status))).toMatchObject({ kind: "rejected", httpStatus: status });
  });
});
