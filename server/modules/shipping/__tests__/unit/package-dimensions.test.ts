import { describe, expect, it } from "vitest";
import { normalizeShipStationPackageDimensions } from "../../shipstation-package-dimensions.domain";
import { retainShippingPackageDimensionsMetadata } from "../../package-dimensions.domain";
import { normalizeShipStationLabelObservation } from "../../carrier-tracking.domain";

const dimensions = { units: "inches", length: 10, width: 8, height: 4 };
const now = new Date("2026-10-01T12:00:00.000Z");
const verified = { version: 1, status: "verified", dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 } };
const hash = "a".repeat(64);
const label = (size: unknown = dimensions) => ({ shipmentId: 601, orderId: 99, trackingNumber: "TRACK601",
  isReturnLabel: false, dimensions: size, shipmentItems: [{ lineItemKey: "wms-item-301", quantity: 1 }] });

describe("observed shipping package dimensions", () => {
  it.each([dimensions, { units: "centimeters", length: 25.4, width: 20.32, height: 10.16 }])(
    "normalizes equivalent provider units without mutating evidence", raw => {
      const before = structuredClone(raw);
      expect(normalizeShipStationPackageDimensions(raw)).toEqual(verified);
      expect(raw).toEqual(before);
    });
  it.each([undefined, null])("keeps omitted measurements unknown: %s", raw => {
    expect(normalizeShipStationPackageDimensions(raw)).toBeNull();
  });
  it.each([{}, { ...dimensions, units: "feet" }, { ...dimensions, length: "10" },
    { ...dimensions, width: 0 }, { ...dimensions, height: -1 }, { ...dimensions, length: Infinity },
    { ...dimensions, width: NaN }, { ...dimensions, height: 1e-10 }, { ...dimensions, length: 1e20 }])(
    "rejects incomplete, untrusted or unsupported measurements %# without retaining raw data", raw => {
      expect(normalizeShipStationPackageDimensions(raw)).toEqual({ version: 1, status: "invalid", code: "SHIPMENT_DIMENSIONS_INVALID" });
    });
  it("records a measured package in the normal label event with stable equivalent-unit replay", () => {
    const first = normalizeShipStationLabelObservation(label(), now);
    const same = normalizeShipStationLabelObservation(label({ units: "centimeters", length: 25.4, width: 20.32, height: 10.16 }), now);
    const missing = normalizeShipStationLabelObservation(label(null), now);
    const changed = normalizeShipStationLabelObservation(label({ ...dimensions, length: 12 }), now);
    expect(first.sanitizedPayload.packageDimensions).toEqual(verified);
    expect(first.eventHash).toBe(same.eventHash);
    expect(first.eventHash).not.toBe(changed.eventHash);
    expect(first.sourceObservationHash).toBe(changed.sourceObservationHash);
    expect(first.shipmentContentsEvidence).toEqual(changed.shipmentContentsEvidence);
    expect(missing.sanitizedPayload).not.toHaveProperty("packageDimensions");
  });
  it("retains latest measurements across missing fields and old observations without erasing metadata", () => {
    const saved = retainShippingPackageDimensionsMetadata({ other: "retained" }, verified, now, hash);
    const before = structuredClone(saved);
    expect(retainShippingPackageDimensionsMetadata(saved, undefined, new Date(now.getTime() + 1000), hash)).toEqual(saved);
    expect(retainShippingPackageDimensionsMetadata(saved, { version: 1, status: "invalid", code: "SHIPMENT_DIMENSIONS_INVALID" },
      new Date(now.getTime() - 1000), hash)).toEqual(saved);
    expect(saved).toEqual(before);
  });
  it("quarantines equal-time contradictions and recovers from a later verified observation, even a replay", () => {
    const first = retainShippingPackageDimensionsMetadata({}, verified, now, hash);
    const other = { ...verified, dimensions: { ...verified.dimensions, lengthMm: 300 } };
    const conflicted = retainShippingPackageDimensionsMetadata(first, other, now, "b".repeat(64));
    expect(conflicted.packageDimensions).toMatchObject({ observation: { status: "invalid", code: "SHIPMENT_DIMENSIONS_CONFLICT" } });
    expect(retainShippingPackageDimensionsMetadata(conflicted, verified, new Date(now.getTime() + 1000), hash).packageDimensions)
      .toEqual({ observation: verified, observedAt: new Date(now.getTime() + 1000).toISOString(), eventHash: hash });
  });
});
