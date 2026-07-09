import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../orders/shipment-rollup", () => ({
  dispatchShipmentEvent: vi.fn(),
  recomputeOrderStatusFromShipments: vi.fn(),
}));

import {
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
} from "../../../orders/shipment-rollup";
import { applyChannelFulfillment } from "../../channel-fulfillment.service";

const dispatchShipmentEventMock = vi.mocked(dispatchShipmentEvent);
const recomputeOrderStatusFromShipmentsMock = vi.mocked(recomputeOrderStatusFromShipments);

const SHIP_DATE = new Date("2026-07-07T22:50:46.218Z");
const TRACKING_NUMBER = "1ZE365H56830499454";

function makeDb(executeResults: Array<{ rows: unknown[] }>) {
  const results = [...executeResults];
  const values = vi.fn(async () => undefined);
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));

  return {
    execute: vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error("Unexpected db.execute call");
      return next;
    }),
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values })),
    __test: {
      values,
      set,
      where,
    },
  };
}

function makeEngine(overrides: Partial<{
  isConfigured: () => boolean;
  markShipped: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isConfigured: overrides.isConfigured ?? vi.fn(() => true),
    markShipped:
      overrides.markShipped ??
      vi.fn(async () => ({
        alreadyInState: false,
      })),
  };
}

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 6531,
    status: "queued",
    tracking_number: null,
    shipping_engine: "shipstation",
    engine_order_ref: "759012411",
    engine_shipment_ref: "echelon-wms-shp-6531",
    shipstation_order_id: null,
    shipstation_order_key: null,
    ...overrides,
  };
}

describe("applyChannelFulfillment shipping-engine close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchShipmentEventMock.mockResolvedValue({ changed: true } as any);
    recomputeOrderStatusFromShipmentsMock.mockResolvedValue({
      warehouseStatus: "shipped",
    } as any);
  });

  it("marks the WMS shipment shipped and closes the engine order from WMS engine refs", async () => {
    const db = makeDb([
      { rows: [shipmentRow()] },
      { rows: [{ oms_fulfillment_order_id: "238826" }] },
      { rows: [] },
    ]);
    const engine = makeEngine();

    const result = await applyChannelFulfillment(
      db,
      204886,
      {
        trackingNumber: TRACKING_NUMBER,
        carrier: "UPS®",
        shipDate: SHIP_DATE,
        source: "shopify_fulfilled_webhook",
        sourceFulfillmentId: "gid://shopify/Fulfillment/6312306376863",
      },
      { shippingEngine: engine },
    );

    expect(dispatchShipmentEventMock).toHaveBeenCalledWith(
      db,
      6531,
      expect.objectContaining({
        kind: "shipped",
        trackingNumber: TRACKING_NUMBER,
        carrier: "UPS®",
        shipDate: SHIP_DATE,
      }),
      expect.objectContaining({ now: SHIP_DATE }),
    );
    expect(engine.markShipped).toHaveBeenCalledWith(
      {
        engine: "shipstation",
        engineOrderRef: "759012411",
        engineShipmentRef: "echelon-wms-shp-6531",
      },
      {
        shipDate: SHIP_DATE,
        trackingNumber: TRACKING_NUMBER,
        carrierCode: "ups",
        notifyCustomer: false,
      },
    );
    expect(result).toMatchObject({
      processed: true,
      shipmentsMarked: 1,
      engineOrdersClosed: 1,
      engineCloseFailures: 0,
    });
    expect(db.__test.values).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          engineOrdersClosed: 1,
          engineCloseFailures: 0,
        }),
      }),
    );
  });

  it("closes the engine order on idempotent replay when WMS is already shipped with the same tracking", async () => {
    const db = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: TRACKING_NUMBER,
          }),
        ],
      },
      { rows: [{ oms_fulfillment_order_id: "238826" }] },
      { rows: [] },
    ]);
    const engine = makeEngine();

    const result = await applyChannelFulfillment(
      db,
      204886,
      {
        trackingNumber: TRACKING_NUMBER,
        carrier: "UPS",
        shipDate: SHIP_DATE,
        source: "shopify_fulfillment_sweep",
      },
      { shippingEngine: engine },
    );

    expect(dispatchShipmentEventMock).not.toHaveBeenCalled();
    expect(engine.markShipped).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      shipmentsMarked: 0,
      engineOrdersClosed: 1,
      engineCloseFailures: 0,
    });
  });

  it("does not roll back WMS or OMS convergence when the engine close fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb([
      { rows: [shipmentRow()] },
      { rows: [{ oms_fulfillment_order_id: "238826" }] },
      { rows: [] },
    ]);
    const engine = makeEngine({
      markShipped: vi.fn(async () => {
        throw new Error("ShipStation timeout");
      }),
    });

    const result = await applyChannelFulfillment(
      db,
      204886,
      {
        trackingNumber: TRACKING_NUMBER,
        carrier: "UPS",
        shipDate: SHIP_DATE,
        source: "shopify_fulfilled_webhook",
      },
      { shippingEngine: engine },
    );

    expect(dispatchShipmentEventMock).toHaveBeenCalledTimes(1);
    expect(recomputeOrderStatusFromShipmentsMock).toHaveBeenCalledWith(db, 204886);
    expect(result).toMatchObject({
      processed: true,
      shipmentsMarked: 1,
      engineOrdersClosed: 0,
      engineCloseFailures: 1,
    });
    errorSpy.mockRestore();
  });
});
