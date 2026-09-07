import { describe, expect, it } from "vitest";
import { inboundTrackingConfigSchema, saveInboundTrackingSchema } from "@shared/procurement/inbound-tracking";
import { acceptsTrackingSnapshot, parseSeaRatesTracking, parseShipStationInboundTracking, trackingDate, trackingFingerprint, trackingRetryDelay } from "../../inbound-tracking.domain";
import { oceanConfig, oceanPayload, parcelConfig, parcelPayload } from "./inbound-tracking.fixtures";
describe("inbound tracking evidence normalization", () => {
  it("preserves carrier dates, explicit estimates and distinct port/AIS timestamp provenance", () => {
    const input = oceanPayload(); const before = structuredClone(input);
    const snapshot = parseSeaRatesTracking(input, oceanConfig.identity);
    expect(input).toEqual(before);
    expect(snapshot).toMatchObject({ sourceUpdatedAt: "2026-09-07T10:00:00.000Z", fromCache: true, arrival: { kind: "port", occurredAt: null, dateText: "2026-10-01 08:00:00", timezone: "America/New_York", actual: false }, vesselPosition: { latitude: 0, longitude: -10.5, observedAt: "2026-09-07T09:00:00.000Z" } });
    expect(snapshot.events[0]).toMatchObject({ actual: true, occurredAt: null, timezone: "Asia/Shanghai", source: "carrier" });
    expect(snapshot.events[1]).toMatchObject({ actual: false, source: "provider_calculated" });
    expect(snapshot).not.toHaveProperty("warehouseArrival"); expect(snapshot).not.toHaveProperty("availableForSale");
  });
  it("never substitutes an interpolated route pin for missing AIS", () => {
    const input = oceanPayload(); input.data.route_data = { ais: { status: "NO_AIS_DATA", data: null } } as never;
    Object.assign(input.data.route_data, { pin: [40, -70] });
    expect(parseSeaRatesTracking(input, oceanConfig.identity)).toMatchObject({ vesselPosition: null, positionStatus: "NO_AIS_DATA" });
  });
  it("retains unknown certainty without calling it actual or estimated", () => {
    const input = oceanPayload(); input.data.route.pod.actual = null as never; input.data.containers[0].events[0].actual = null as never;
    expect(parseSeaRatesTracking(input, oceanConfig.identity).arrival?.actual).toBeNull();
    expect(parseSeaRatesTracking(input, oceanConfig.identity).events[0].actual).toBeNull();
  });
  it("uses explicit UTC offsets and rejects invalid dates rather than server timezone guessing", () => {
    expect(trackingDate("2026-09-07T09:00:00-04:00").instant).toBe("2026-09-07T13:00:00.000Z");
    expect(trackingDate("2026-09-07 09:00:00").instant).toBeNull();
    for (const value of ["2026-02-30 12:00:00", "2026-09-07 25:00:00", "yesterday", "2026-13-01 00:00:00"]) expect(() => trackingDate(value)).toThrow();
  });
  it("does not attach a different reference or container to the shipment", () => {
    const input = oceanPayload(); input.data.metadata.number = "OTHER1234567";
    expect(() => parseSeaRatesTracking(input, oceanConfig.identity)).toThrow("does not match");
    input.data.metadata.number = "TEST1234567"; input.data.containers[0].number = "FAKE1234567";
    expect(() => parseSeaRatesTracking(input, oceanConfig.identity)).toThrow("another container");
    const parcel = parcelPayload(); parcel.tracking_number = "1ZOTHER";
    expect(() => parseShipStationInboundTracking(parcel, parcelConfig.identity)).toThrow("does not match");
  });
  it("verifies explicit carrier identities and permits only the documented postal alias", () => {
    const ocean = oceanPayload(); Object.assign(ocean.data.metadata, { sealine: "CMDU" });
    expect(() => parseSeaRatesTracking(ocean, { ...oceanConfig.identity, carrierCode: "MAEU" })).toThrow("saved shipping line");
    expect(parseSeaRatesTracking(ocean, { ...oceanConfig.identity, carrierCode: "CMDU" }).carrierName).toBe("Fixture ocean line");
    const parcel = { ...parcelPayload(), carrier_code: "fedex" };
    expect(() => parseShipStationInboundTracking(parcel, parcelConfig.identity)).toThrow("saved carrier");
    expect(parseShipStationInboundTracking({ ...parcel, carrier_code: "usps" }, { ...parcelConfig.identity, carrierCode: "stamps_com" }).status).toBe("Delivered");
  });
  it("rejects incomplete and duplicate provider identity graphs", () => {
    const input = oceanPayload(); input.data.locations.pop();
    expect(() => parseSeaRatesTracking(input, oceanConfig.identity)).toThrow("missing location");
    const duplicate = oceanPayload(); duplicate.data.containers[0].events.push(duplicate.data.containers[0].events[0]);
    expect(() => parseSeaRatesTracking(duplicate, oceanConfig.identity)).toThrow("duplicate event");
  });
  it("supports bill-of-lading consolidation while preserving per-container events", () => {
    const input = oceanPayload(); input.data.metadata.number = "BILL123"; input.data.metadata.type = "BL";
    input.data.containers.push({ ...structuredClone(input.data.containers[0]), number: "TEST7654321" });
    const snapshot = parseSeaRatesTracking(input, { ...oceanConfig.identity, referenceType: "bill_of_lading", reference: "BILL123" });
    expect(snapshot.events.map((event) => event.container)).toEqual(["TEST1234567", "TEST1234567", "TEST7654321", "TEST7654321"]);
  });
  it("canonicalizes reordered event arrays and suppresses exact parcel duplicates", () => {
    const input = oceanPayload(); const first = parseSeaRatesTracking(input, oceanConfig.identity); input.data.containers[0].events.reverse();
    expect(trackingFingerprint(parseSeaRatesTracking(input, oceanConfig.identity))).toBe(trackingFingerprint(first));
    const parcel = parcelPayload(); parcel.events.push({ ...parcel.events[0] });
    const snapshot = parseShipStationInboundTracking(parcel, parcelConfig.identity);
    expect(snapshot.events).toHaveLength(1); expect(snapshot.arrival).toMatchObject({ kind: "carrier_destination", actual: true });
  });
  it("accepts a new correction but never promotes older cached carrier data", () => {
    const current = parseSeaRatesTracking(oceanPayload(), oceanConfig.identity);
    expect(acceptsTrackingSnapshot(current, { ...current, status: "CORRECTED", sourceUpdatedAt: "2026-09-07T11:00:00.000Z" })).toBe(true);
    expect(acceptsTrackingSnapshot(current, { ...current, sourceUpdatedAt: "2026-09-07T09:00:00.000Z" })).toBe(false);
    expect(acceptsTrackingSnapshot(current, { ...current, sourceUpdatedAt: null })).toBe(false);
    const parcel = parseShipStationInboundTracking(parcelPayload(), parcelConfig.identity);
    expect(acceptsTrackingSnapshot(parcel, { ...parcel, latestActualEventAt: null })).toBe(false);
    expect(acceptsTrackingSnapshot(null, current)).toBe(true);
  });
  it("retains an actual parcel delivery timestamp as ordering evidence even when event history is empty", () => {
    const input = parcelPayload(); input.events = [];
    const current = parseShipStationInboundTracking(input, parcelConfig.identity);
    expect(current.latestActualEventAt).toBe("2026-09-07T09:00:00.000Z");
    expect(acceptsTrackingSnapshot(current, { ...current, latestActualEventAt: null })).toBe(false);
  });
  it("validates identities, explicit config, revision and request keys", () => {
    expect(inboundTrackingConfigSchema.parse({ ...oceanConfig, identity: { ...oceanConfig.identity, reference: " test1234567 " } }).identity.reference).toBe("TEST1234567");
    for (const reference of ["", "https://internal.example", "TEST123", "TEST1234567?key=abc"]) expect(inboundTrackingConfigSchema.safeParse({ ...oceanConfig, identity: { ...oceanConfig.identity, reference } }).success).toBe(false);
    expect(inboundTrackingConfigSchema.safeParse({ ...oceanConfig, identity: parcelConfig.identity }).success).toBe(false);
    expect(saveInboundTrackingSchema.safeParse({ requestKey: "not-uuid", referenceId: null, expectedRevision: 0, config: oceanConfig }).success).toBe(false);
  });
  it("bounds deterministic retries and honors longer provider backoff", () => {
    expect(trackingRetryDelay(1, null)).toBe(300_000); expect(trackingRetryDelay(2, null)).toBe(600_000);
    expect(trackingRetryDelay(1, 3_600_000)).toBe(3_600_000); expect(trackingRetryDelay(50, null)).toBe(86_400_000);
    expect(() => trackingRetryDelay(0, null)).toThrow(); expect(() => trackingRetryDelay(1, NaN)).toThrow();
  });
});
