import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createShipStationEngine,
  toEngineRef,
  fromEngineRef,
} from "../../adapters/shipstation.adapter";
import { normalizeCarrier, parseProviderAmountCents } from "../../types";
import type { ShippingEngine } from "../../engine";
import type { ShipStationServiceHandle } from "../../adapters/shipstation.adapter";
import type { EngineRef } from "../../types";

function mockSsService(overrides: Partial<ShipStationServiceHandle> = {}): ShipStationServiceHandle {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    pushShipment: vi.fn().mockResolvedValue({ shipstationOrderId: 999, orderKey: "echelon-wms-shp-1" }),
    cancelOrder: vi.fn().mockResolvedValue({ alreadyInState: false }),
    putOrderOnHold: vi.fn().mockResolvedValue(undefined),
    releaseOrderFromHold: vi.fn().mockResolvedValue(undefined),
    markAsShipped: vi.fn().mockResolvedValue({ alreadyInState: false }),
    updateSortRank: vi.fn().mockResolvedValue({ touched: 1 }),
    updateSortRankSingle: vi.fn().mockResolvedValue(undefined),
    getOrderById: vi.fn().mockResolvedValue({ orderId: 999, orderStatus: "awaiting_shipment" }),
    getShipments: vi.fn().mockResolvedValue([]),
    processShipNotify: vi.fn().mockResolvedValue(1),
    registerWebhook: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("parseProviderAmountCents", () => {
  it("parses exact cents without floating-point multiplication", () => {
    expect(parseProviderAmountCents(5.99)).toBe(599);
    expect(parseProviderAmountCents("0.10")).toBe(10);
  });

  it("rejects fractional cents, negatives, exponents, and unsafe totals", () => {
    expect(parseProviderAmountCents("1.001")).toBeNull();
    expect(parseProviderAmountCents("-1.00")).toBeNull();
    expect(parseProviderAmountCents("1e3")).toBeNull();
    expect(parseProviderAmountCents("999999999999999.99")).toBeNull();
  });
});

const ref: EngineRef = { engine: "shipstation", engineOrderRef: "999" };

describe("ShipStation Engine Adapter", () => {
  let ss: ShipStationServiceHandle;
  let engine: ShippingEngine;

  beforeEach(() => {
    ss = mockSsService();
    engine = createShipStationEngine(ss);
  });

  it("has engine name 'shipstation'", () => {
    expect(engine.engineName).toBe("shipstation");
  });

  it("delegates isConfigured to underlying service", () => {
    expect(engine.isConfigured()).toBe(true);
    expect(ss.isConfigured).toHaveBeenCalled();
  });

  describe("cancel", () => {
    it("translates engineRef to SS order ID and delegates", async () => {
      const result = await engine.cancel(ref);
      expect(ss.cancelOrder).toHaveBeenCalledWith(999);
      expect(result.alreadyInState).toBe(false);
    });

    it("returns alreadyInState when SS order is terminal", async () => {
      ss = mockSsService({
        cancelOrder: vi.fn().mockResolvedValue({ alreadyInState: true }),
      });
      engine = createShipStationEngine(ss);
      const result = await engine.cancel(ref);
      expect(result.alreadyInState).toBe(true);
    });

    it("rejects refs for wrong engine", async () => {
      const wrongRef: EngineRef = { engine: "pirateship", engineOrderRef: "1" };
      await expect(engine.cancel(wrongRef)).rejects.toThrow("received ref for engine 'pirateship'");
    });

    it("rejects non-numeric engine order ref", async () => {
      const badRef: EngineRef = { engine: "shipstation", engineOrderRef: "abc" };
      await expect(engine.cancel(badRef)).rejects.toThrow("Invalid ShipStation order ref");
    });
  });

  describe("hold / releaseHold", () => {
    it("delegates hold to putOrderOnHold", async () => {
      await engine.hold(ref);
      expect(ss.putOrderOnHold).toHaveBeenCalledWith(999);
    });

    it("delegates releaseHold to releaseOrderFromHold", async () => {
      await engine.releaseHold(ref);
      expect(ss.releaseOrderFromHold).toHaveBeenCalledWith(999);
    });
  });

  describe("markShipped", () => {
    it("delegates with options", async () => {
      const opts = {
        shipDate: "2026-05-30",
        trackingNumber: "1Z999",
        carrierCode: "ups",
        notifyCustomer: false,
      };
      const result = await engine.markShipped(ref, opts);
      expect(ss.markAsShipped).toHaveBeenCalledWith(999, opts);
      expect(result.alreadyInState).toBe(false);
    });
  });

  describe("getState", () => {
    it("returns canonical state from SS order", async () => {
      ss = mockSsService({
        getOrderById: vi.fn().mockResolvedValue({
          orderId: 999,
          orderStatus: "shipped",
          trackingNumber: "1Z999",
          carrierCode: "ups",
          shipDate: "2026-05-01",
        }),
      });
      engine = createShipStationEngine(ss);

      const state = await engine.getState(ref);
      expect(state).not.toBeNull();
      expect(state!.status).toBe("shipped");
      expect(state!.trackingNumber).toBe("1Z999");
      expect(state!.engineRef).toEqual(ref);
    });

    it("returns null when SS order not found", async () => {
      ss = mockSsService({
        getOrderById: vi.fn().mockResolvedValue(null),
      });
      engine = createShipStationEngine(ss);

      const state = await engine.getState(ref);
      expect(state).toBeNull();
    });
  });

  describe("getShipments", () => {
    it("normalizes SS shipments to canonical events", async () => {
      ss = mockSsService({
        getShipments: vi.fn().mockResolvedValue([
          {
            shipmentId: 1001,
            orderId: 999,
            orderKey: "echelon-wms-shp-1",
            trackingNumber: "1Z999",
            carrierCode: "stamps_com",
            serviceCode: "usps_ground_advantage",
            shipDate: "2026-05-01",
            voidDate: null,
            shipmentCost: 5.99,
          },
          {
            shipmentId: 1002,
            orderId: 999,
            orderKey: "echelon-wms-shp-2",
            trackingNumber: "",
            carrierCode: "fedex",
            shipDate: "2026-05-02",
            voidDate: "2026-05-03",
            shipmentCost: 0,
          },
        ]),
      });
      engine = createShipStationEngine(ss);

      const events = await engine.getShipments(ref, {
        orderNumber: "#59826",
      });
      expect(ss.getShipments).toHaveBeenCalledWith(999, {
        orderNumber: "#59826",
      });
      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe("shipped");
      if (events[0].kind === "shipped") {
        expect(events[0].carrier).toBe("USPS");
        expect(events[0].carrierRaw).toBe("stamps_com");
        expect(events[0].trackingNumber).toBe("1Z999");
        expect(events[0].serviceCode).toBe("usps_ground_advantage");
        expect(events[0].carrierCostCents).toBe(599);
        expect(events[0].carrierCostSource).toBe("shipstation_shipments_api");
      }
      expect(events[1].kind).toBe("voided");
    });
  });

  describe("applyInboundShipmentAuthority", () => {
    it("delegates all order packages to the authoritative SHIP_NOTIFY resolver", async () => {
      const processed = await engine.applyInboundShipmentAuthority!({
        engineRef: ref,
        orderNumber: "#59826",
      });

      expect(ss.processShipNotify).toHaveBeenCalledWith(
        "/shipments?orderNumber=%2359826",
      );
      expect(processed).toBe(1);
    });

    it("rejects a blank order number", async () => {
      await expect(
        engine.applyInboundShipmentAuthority!({
          engineRef: ref,
          orderNumber: "   ",
        }),
      ).rejects.toThrow(
        "ShipStation inbound shipment authority requires an order number",
      );
      expect(ss.processShipNotify).not.toHaveBeenCalled();
    });
  });

  describe("upsertShipment", () => {
    it("delegates to pushShipment by shipmentId", async () => {
      const payload = {
        shipmentId: 42,
        orderId: 10,
        orderNumber: "ORD-100",
        channelId: 1,
        warehouseId: 1,
        customer: { name: "Test", email: "t@t.com" },
        shippingAddress: {
          name: "Test",
          company: null,
          street1: "123 St",
          street2: null,
          city: "NY",
          state: "NY",
          postalCode: "10001",
          country: "US",
        },
        financials: {
          amountPaidCents: 1000,
          taxCents: 0,
          shippingCents: 500,
          discountCents: 0,
          totalCents: 1500,
          currency: "USD",
        },
        items: [{ itemId: 1, sku: "SKU-1", name: "Card", quantity: 1, unitPriceCents: 1000 }],
        orderPlacedAt: "2026-05-01",
        externalOrderId: "ext-1",
        sortRank: "A",
      };

      const result = await engine.upsertShipment(payload);
      expect(ss.pushShipment).toHaveBeenCalledWith(42);
      expect(result.engineRef.engine).toBe("shipstation");
      expect(result.engineRef.engineOrderRef).toBe("999");
    });
  });

  describe("registerWebhook", () => {
    it("delegates to ss.registerWebhook", async () => {
      await engine.registerWebhook("https://example.com/webhook");
      expect(ss.registerWebhook).toHaveBeenCalledWith("https://example.com/webhook");
    });
  });
});

describe("toEngineRef / fromEngineRef", () => {
  it("round-trips correctly", () => {
    const ref = toEngineRef(12345, "echelon-wms-shp-42");
    expect(ref.engine).toBe("shipstation");
    expect(ref.engineOrderRef).toBe("12345");
    expect(ref.engineShipmentRef).toBe("echelon-wms-shp-42");

    const ssId = fromEngineRef(ref);
    expect(ssId).toBe(12345);
  });

  it("handles missing orderKey", () => {
    const ref = toEngineRef(100);
    expect(ref.engineShipmentRef).toBeUndefined();
  });

  it("rejects wrong engine name", () => {
    expect(() => fromEngineRef({ engine: "other", engineOrderRef: "1" })).toThrow();
  });

  it("rejects non-positive integer", () => {
    expect(() => fromEngineRef({ engine: "shipstation", engineOrderRef: "0" })).toThrow();
    expect(() => fromEngineRef({ engine: "shipstation", engineOrderRef: "-5" })).toThrow();
  });
});

describe("normalizeCarrier", () => {
  it("maps stamps_com to USPS", () => {
    expect(normalizeCarrier("stamps_com")).toBe("USPS");
    expect(normalizeCarrier("Stamps_Com")).toBe("USPS");
  });

  it("maps usps variants", () => {
    expect(normalizeCarrier("usps")).toBe("USPS");
    expect(normalizeCarrier("USPS")).toBe("USPS");
  });

  it("maps fedex", () => {
    expect(normalizeCarrier("fedex")).toBe("FEDEX");
    expect(normalizeCarrier("FedEx")).toBe("FEDEX");
  });

  it("maps ups variants", () => {
    expect(normalizeCarrier("ups")).toBe("UPS");
    expect(normalizeCarrier("ups_walleted")).toBe("UPS");
  });

  it("maps dhl variants", () => {
    expect(normalizeCarrier("dhl")).toBe("DHL");
    expect(normalizeCarrier("dhl_express_worldwide")).toBe("DHL");
  });

  it("falls back to OTHER for unknown carriers", () => {
    expect(normalizeCarrier("pirateship")).toBe("OTHER");
    expect(normalizeCarrier("")).toBe("OTHER");
  });
});
