import { describe, expect, it } from "vitest";
import { normalizeShipStationDate, normalizeShipStationV1Date, shipStationV1Instant } from "@shared/utils/shipstation-date";

describe("ShipStation boundary dates", () => {
  it.each([
    ["2026-09-10T09:38:29.5370000", "2026-09-10T16:38:29.537Z"],
    ["2026-01-10 09:38:29.5370000", "2026-01-10T17:38:29.537Z"],
    ["2026-09-10T09:38:29.537Z", "2026-09-10T09:38:29.537Z"],
    ["2026-09-10T09:38:29.5370000-07:00", "2026-09-10T16:38:29.537Z"],
    ["2026-09-10T09:38:29.5371234", "2026-09-10T16:38:29.537Z"],
    ["2026-03-08T01:59:59.9999999", "2026-03-08T09:59:59.999Z"],
    ["2026-03-08T03:00:00", "2026-03-08T10:00:00.000Z"],
    ["2026-11-01T01:30:00-07:00", "2026-11-01T08:30:00.000Z"],
    ["2026-11-01T01:30:00-08:00", "2026-11-01T09:30:00.000Z"],
  ])("normalizes %s with the provider timezone contract", (raw, expected) => {
    expect(normalizeShipStationV1Date(raw, "voidDate")).toMatchObject({ kind: "timestamp", iso: expected });
  });

  it("keeps calendar dates distinct from instants", () => {
    expect(normalizeShipStationV1Date("2026-09-16", "shipDate")).toEqual({ kind: "date", date: "2026-09-16" });
    expect(shipStationV1Instant("2026-09-16", "shipDate")).toBeNull();
  });

  it.each([null, undefined, "", "  "])("represents missing dates explicitly", (raw) => {
    expect(normalizeShipStationV1Date(raw, "shipDate")).toEqual({ kind: "missing" });
  });

  it.each(["0000-01-01", "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00",
    "2026-02-30", "2026-13-10", "2026-01-01T24:00:00", "2026-01-01T00:60:00",
    "2026-01-01T00:00:60", "2026-01-01T00:00:00+24:00", "not-a-date", 42, {}, "a".repeat(81)])(
    "rejects genuinely invalid values: %s", (raw) => {
      expect(() => normalizeShipStationV1Date(raw, "voidDate")).toThrowError(expect.objectContaining({ code: "SHIPSTATION_DATE_INVALID" }));
    });

  it.each(["2026-03-08T02:30:00", "2026-11-01T01:30:00"])("does not invent an instant for a DST gap/overlap: %s", (raw) => {
    expect(() => normalizeShipStationV1Date(raw, "voidDate")).toThrowError(expect.objectContaining({ code: "SHIPSTATION_DATE_INVALID" }));
  });

  it("does not apply Pacific rules to UTC tracking events", () => {
    expect(normalizeShipStationDate("2026-09-10T09:38:29.5370000", "occurred_at", "UTC"))
      .toEqual({ kind: "timestamp", iso: "2026-09-10T09:38:29.537Z", sourceTimeZone: "UTC" });
  });
});
