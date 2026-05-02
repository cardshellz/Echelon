import { describe, expect, it } from "vitest";
import { resolveShipStationShipmentTimestamp } from "../../shipstation-date.util";

describe("resolveShipStationShipmentTimestamp", () => {
  it("uses the processing timestamp for ShipStation date-only shipDate values", () => {
    const fallback = new Date("2026-05-02T18:49:25.469Z");

    const resolved = resolveShipStationShipmentTimestamp("2026-05-02", fallback);

    expect(resolved).toBe(fallback);
  });

  it("preserves valid full timestamps", () => {
    const fallback = new Date("2026-05-02T18:49:25.469Z");

    const resolved = resolveShipStationShipmentTimestamp(
      "2026-05-02T18:47:05.463Z",
      fallback,
    );

    expect(resolved.toISOString()).toBe("2026-05-02T18:47:05.463Z");
  });

  it("uses the fallback for missing or invalid values", () => {
    const fallback = new Date("2026-05-02T18:49:25.469Z");

    expect(resolveShipStationShipmentTimestamp(null, fallback)).toBe(fallback);
    expect(resolveShipStationShipmentTimestamp("not-a-date", fallback)).toBe(fallback);
  });
});
