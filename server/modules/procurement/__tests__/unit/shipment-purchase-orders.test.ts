import { describe, expect, it, vi } from "vitest";
import { readShipmentPurchaseOrders } from "../../shipment-purchase-orders.repository";
import { createShipmentTrackingService } from "../../shipment-tracking.service";

describe("shipment purchase-order projection", () => {
  it("does not query an empty shipment page", async () => {
    const executor = { execute: vi.fn() };
    expect(await readShipmentPurchaseOrders(executor, [])).toEqual(new Map());
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("validates resource identities before querying", async () => {
    const executor = { execute: vi.fn() };
    for (const id of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      await expect(readShipmentPurchaseOrders(executor, [id])).rejects.toThrow();
    }
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("loads all page references in one query and keeps unlinked shipments explicit", async () => {
    const executor = { execute: vi.fn().mockResolvedValue({ rows: [
      { shipmentId: 42, id: 17, poNumber: "TEST-PO-17" },
      { shipmentId: 42, id: 99, poNumber: "TEST-PO-99" },
      { shipmentId: 43, id: 17, poNumber: "TEST-PO-17" },
    ] }) };
    expect(await readShipmentPurchaseOrders(executor, [42, 43, 44, 42])).toEqual(new Map([
      [42, [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }]],
      [43, [{ id: 17, poNumber: "TEST-PO-17" }]],
      [44, []],
    ]));
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("fails instead of inventing labels or accepting unrelated projection rows", async () => {
    const executor = { execute: vi.fn().mockResolvedValue({ rows: [{ shipmentId: 42, id: 17, poNumber: "" }] }) };
    await expect(readShipmentPurchaseOrders(executor, [42])).rejects.toThrow();
    executor.execute.mockResolvedValue({ rows: [{ shipmentId: 99, id: 17, poNumber: "TEST-PO-17" }] });
    await expect(readShipmentPurchaseOrders(executor, [42])).rejects.toThrow("unrequested shipment");
  });
});

describe("shipment list and detail purchase references", () => {
  it("keeps list pagination and ordering while batching only the returned page", async () => {
    const filters = { status: ["booked", "in_transit"], limit: 2, offset: 5, search: "TEST" };
    const page = [{ id: 43, shipmentNumber: "SPLIT-43" }, { id: 42, shipmentNumber: "SHARED-42" }];
    const storage = {
      getInboundShipments: vi.fn().mockResolvedValue(page),
      getInboundShipmentPurchaseOrders: vi.fn().mockResolvedValue(new Map([
        [42, [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }]],
        [43, [{ id: 17, poNumber: "TEST-PO-17" }]],
      ])),
    };
    const service = createShipmentTrackingService({} as never, storage as never);
    expect(await service.getShipments(filters)).toEqual([
      { ...page[0], purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }] },
      { ...page[1], purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }] },
    ]);
    expect(storage.getInboundShipments).toHaveBeenCalledWith(filters);
    expect(storage.getInboundShipmentPurchaseOrders).toHaveBeenCalledExactlyOnceWith([43, 42]);
    expect(page[0]).not.toHaveProperty("purchaseOrders");
  });

  it("uses the same read projection for a detail and propagates read failures", async () => {
    const storage = { getInboundShipmentPurchaseOrders: vi.fn().mockResolvedValue(new Map([[44, []]])) };
    const service = createShipmentTrackingService({} as never, storage as never);
    expect(await service.getShipmentPurchaseOrders(44)).toEqual([]);
    expect(storage.getInboundShipmentPurchaseOrders).toHaveBeenCalledExactlyOnceWith([44]);
    storage.getInboundShipmentPurchaseOrders.mockRejectedValue(new Error("Database read failed"));
    await expect(service.getShipmentPurchaseOrders(44)).rejects.toThrow("Database read failed");
  });
});
