import { describe, expect, it, vi } from "vitest";
import { mapShipStationShipment } from "../../shipstation-shipment-fact.mapper";
import {
  parseShipmentFact, ShipmentFactError, shipmentFactContentHash, type ShipmentFact,
} from "../../shipment-fact.domain";

const shipment = (overrides: Record<string, unknown> = {}) => ({
  shipmentId: 123456789,
  orderNumber: "65128",
  customerEmail: "ignored@example.test",
  shipDate: "2026-01-15",
  createDate: "2026-01-15T09:41:22.1230000",
  trackingNumber: " 9400100000000000000000 ",
  carrierCode: "stamps_com",
  serviceCode: "usps_ground_advantage",
  isReturnLabel: false,
  voided: false,
  voidDate: null,
  shipTo: { name: "ignored" },
  shipmentItems: [
    { orderItemId: 1, lineItemKey: "36256756891807", sku: "SHLZ-TOP-35PT-CLR-P25", quantity: 2, name: "ignored" },
    { orderItemId: 2, lineItemKey: null, sku: " ", quantity: 1 },
  ],
  ...overrides,
});
const resolver = () => vi.fn((ref: string) => (ref === "36256756891807" ? 124243 : null));

describe("ShipStation shipment fact mapper", () => {
  it("maps an outbound shipment and resolves each purchased line through the supplied resolver", () => {
    const resolveOrderLine = resolver();
    const result = mapShipStationShipment(shipment(), "history_import", resolveOrderLine);
    expect(result).toEqual({
      kind: "outbound",
      void: null,
      fact: {
        engine: "shipstation",
        engineShipmentId: "123456789",
        shipDate: "2026-01-15",
        carrier: "stamps_com",
        serviceCode: "usps_ground_advantage",
        trackingNumber: "9400100000000000000000",
        source: "history_import",
        items: [
          { lineNumber: 1, channelLineRef: "36256756891807", omsOrderLineId: 124243, sku: "SHLZ-TOP-35PT-CLR-P25", quantity: 2, purpose: "fulfillment" },
          { lineNumber: 2, channelLineRef: null, omsOrderLineId: null, sku: null, quantity: 1, purpose: "fulfillment" },
        ],
      },
    });
    expect(resolveOrderLine).toHaveBeenCalledTimes(1);
    expect(resolveOrderLine).toHaveBeenCalledWith("36256756891807");
  });

  it("does not mutate its input and reads nothing personal from it", () => {
    const input = shipment();
    const before = structuredClone(input);
    const result = mapShipStationShipment(input, "engine_event", resolver());
    expect(input).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("ignored");
  });

  it("treats a return label as not an outbound shipment", () => {
    expect(mapShipStationShipment(shipment({ isReturnLabel: true }), "history_import", resolver()))
      .toEqual({ kind: "return_label", engineShipmentId: "123456789" });
  });

  it("reports a voided shipment as the shipment fact plus a separate void fact", () => {
    const result = mapShipStationShipment(
      shipment({ voided: true, voidDate: "2026-01-16T08:00:00.0000000" }), "history_import", resolver());
    expect(result.kind).toBe("outbound");
    expect(result).toMatchObject({ void: { engine: "shipstation", engineShipmentId: "123456789", voidDate: "2026-01-16" } });
    expect(mapShipStationShipment(shipment({ voided: true }), "history_import", resolver()))
      .toMatchObject({ void: { voidDate: null } });
  });

  it("keeps a package with no items, and drops items that report nothing shipped", () => {
    expect(mapShipStationShipment(shipment({ shipmentItems: null }), "engine_event", resolver()))
      .toMatchObject({ kind: "outbound", fact: { items: [] } });
    const result = mapShipStationShipment(shipment({
      shipmentItems: [{ lineItemKey: "1", sku: "A", quantity: 0 }, { lineItemKey: "2", sku: "B", quantity: 3 }],
    }), "engine_event", () => null);
    expect(result).toMatchObject({ fact: { items: [{ lineNumber: 2, channelLineRef: "2", quantity: 3 }] } });
  });

  it("accepts numeric identifiers and timestamps on the ship date", () => {
    const result = mapShipStationShipment(
      shipment({ shipmentId: "987", shipDate: "2026-02-03T00:00:00.0000000", shipmentItems: [{ lineItemKey: 55, sku: "A", quantity: 1 }] }),
      "engine_event", () => 9);
    expect(result).toMatchObject({ fact: { engineShipmentId: "987", shipDate: "2026-02-03", items: [{ channelLineRef: "55", omsOrderLineId: 9 }] } });
  });

  it.each([
    ["missing shipment id", { shipmentId: undefined }],
    ["non-positive shipment id", { shipmentId: 0 }],
    ["missing ship date", { shipDate: undefined }],
    ["malformed ship date", { shipDate: "15/01/2026" }],
    ["fractional quantity", { shipmentItems: [{ lineItemKey: "1", sku: "A", quantity: 1.5 }] }],
  ])("rejects %s as a permanent error", (_label, overrides) => {
    let caught: unknown;
    try { mapShipStationShipment(shipment(overrides), "history_import", resolver()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ShipmentFactError);
    expect(caught).toMatchObject({ code: "SHIPMENT_FACT_INVALID", classification: "permanent" });
  });
});

describe("shipment fact rules", () => {
  const fact: ShipmentFact = {
    engine: "shipstation", engineShipmentId: "1", shipDate: "2026-01-15", carrier: null, serviceCode: null,
    trackingNumber: null, source: "engine_event",
    items: [
      { lineNumber: 1, channelLineRef: "a", omsOrderLineId: 10, sku: "A", quantity: 1, purpose: "fulfillment" },
      { lineNumber: 2, channelLineRef: "b", omsOrderLineId: null, sku: "B", quantity: 2, purpose: "replacement" },
    ],
  };

  it("gives the same fingerprint to the same engine report regardless of source, resolution or item order", () => {
    const replay: ShipmentFact = {
      ...fact, source: "history_import",
      items: [{ ...fact.items[1], omsOrderLineId: 77 }, { ...fact.items[0], omsOrderLineId: null }],
    };
    expect(shipmentFactContentHash(replay)).toBe(shipmentFactContentHash(fact));
    expect(shipmentFactContentHash(fact)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["quantity", { items: [{ ...fact.items[0], quantity: 2 }, fact.items[1]] }],
    ["tracking number", { trackingNumber: "1Z" }],
    ["ship date", { shipDate: "2026-01-16" }],
    ["purpose", { items: [fact.items[0], { ...fact.items[1], purpose: "fulfillment" as const }] }],
  ])("changes the fingerprint when the reported %s differs", (_label, overrides) => {
    expect(shipmentFactContentHash({ ...fact, ...overrides })).not.toBe(shipmentFactContentHash(fact));
  });

  it.each([
    ["a sales channel style engine name", { engine: "Shopify Store" }],
    ["an empty engine shipment id", { engineShipmentId: " " }],
    ["a zero quantity", { items: [{ ...fact.items[0], quantity: 0 }] }],
    ["duplicate line numbers", { items: [fact.items[0], { ...fact.items[1], lineNumber: 1 }] }],
    ["an unknown purpose", { items: [{ ...fact.items[0], purpose: "gift" }] }],
    ["an unknown field", { cost: 12.5 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseShipmentFact({ ...fact, ...overrides })).toThrow(ShipmentFactError);
  });
});
