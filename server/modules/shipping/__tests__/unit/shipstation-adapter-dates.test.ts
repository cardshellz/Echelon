import { describe, expect, it, vi } from "vitest";
import { createShipStationEngine, type ShipStationServiceHandle } from "../../adapters/shipstation.adapter";
import { deriveReconcileEvent } from "../../reconcile-derive";

function fixture(shipDate: string, holdUntilDate: string) {
  const shipment = { shipmentId: 23, orderId: 42, orderKey: "echelon-wms-shp-42", shipDate,
    trackingNumber: "1Z123", carrierCode: "ups", isReturnLabel: false };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider mutation"); };
  const handle: ShipStationServiceHandle = {
    isConfigured: () => true,
    pushShipment: unexpected, appendShipmentItems: unexpected, cancelOrder: unexpected,
    putOrderOnHold: unexpected, releaseOrderFromHold: unexpected, markAsShipped: unexpected,
    updateSortRank: unexpected, updateSortRankSingle: unexpected,
    getOrderById: vi.fn(async () => ({ orderStatus: "shipped", shipDate, holdUntilDate })),
    getShipments: vi.fn(async () => [shipment]),
    observeProviderLabels: vi.fn(async () => undefined),
    processShipNotify: unexpected, registerWebhook: unexpected,
  };
  return { engine: createShipStationEngine(handle), handle, shipment, ref: { engine: "shipstation", engineOrderRef: "42" } };
}

describe("ShipStation engine boundary date handling", () => {
  it("keeps calendar dates separate and still selects the package for authoritative reconciliation", async () => {
    const { engine, ref } = fixture("2026-09-16", "2026-09-18");
    const state = await engine.getState(ref);
    expect(state).toMatchObject({ shipDate: null, shipCalendarDate: "2026-09-16", holdUntil: null, holdUntilDate: "2026-09-18" });
    const events = await engine.getShipments(ref);
    expect(events).toEqual([expect.objectContaining({ kind: "shipped", shipDate: null, shipCalendarDate: "2026-09-16" })]);
    expect(deriveReconcileEvent({ engineState: state!, currentWmsShipmentStatus: "queued", shipments: events }))
      .toMatchObject({ kind: "shipped", shipDate: null, shipCalendarDate: "2026-09-16" });
  });

  it("converts full V1 timestamps before use but passes the original payload to audit storage", async () => {
    const { engine, ref, handle, shipment } = fixture("2026-09-16T09:00:00.0000000", "2026-01-18T09:00:00.0000000");
    const before = structuredClone(shipment);
    const state = await engine.getState(ref);
    expect(state?.shipDate?.toISOString()).toBe("2026-09-16T16:00:00.000Z");
    expect(state?.holdUntil?.toISOString()).toBe("2026-01-18T17:00:00.000Z");
    const events = await engine.getShipments(ref);
    expect(events).toEqual([expect.objectContaining({ shipDate: new Date("2026-09-16T16:00:00.000Z") })]);
    expect(handle.observeProviderLabels).toHaveBeenCalledWith([before]);
    expect(shipment).toEqual(before);
  });
});
