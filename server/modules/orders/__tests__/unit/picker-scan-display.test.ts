import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PickingUseCases, withScanDisplay } from "../../picking.use-cases";

// 2026-10-05: after the picking ownership rewrite (#1672) the gun received no
// barcode or photo for any line. Scans of product barcodes stopped matching
// (only a typed SKU still did) and the pick screen showed no pictures.

const C11 = { id: 11, code: "C-11", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" };

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, orderId: 63776, productId: null, catalogProductId: null, inventoryTracking: null,
    sku: "EG-SLV-PF-P100", name: "Sleeves", quantity: 2, pickedQuantity: 0, fulfilledQuantity: 0,
    requiresShipping: 1, status: "pending", location: "C-11", onHold: false, barcode: null, imageUrl: null,
    ...overrides,
  };
}

function fixture() {
  const storage = {
    getPickQueueOrders: vi.fn(async () => [] as unknown[]),
    getOrderById: vi.fn(async () => ({ id: 63776, orderNumber: "#63776", warehouseId: 1, warehouseStatus: "ready",
      onHold: 0, assignedPickerId: null, startedAt: null })),
    getOrderItems: vi.fn(async () => [line()]),
    getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: "EG-SLV-PF-P100", requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 11, variantQty: 5 }]),
    getAllWarehouseLocations: vi.fn(async () => [C11]),
    getUser: vi.fn(async () => null),
    getChannelById: vi.fn(async () => undefined),
    getBinLocationFromInventoryBySku: vi.fn(),
    getScanDisplayBySkus: vi.fn(async (skus: readonly string[]) => new Map(skus.map((sku) =>
      [sku.toUpperCase(), { barcode: "0850041234567", imageUrl: "https://cdn.example/sleeves.jpg" }]))),
  };
  const replenishment = { predictReplenAfterPick: vi.fn(async () => null) };
  const service = new PickingUseCases({} as any, {} as any, replenishment as any, storage as any);
  return { service, storage };
}

describe("withScanDisplay", () => {
  const display = new Map([["EG-SLV-PF-P100", { barcode: "0850041234567", imageUrl: "https://cdn.example/sleeves.jpg" }]]);

  it("gives a pending line the catalog's current barcode and photo", () => {
    expect(withScanDisplay(line({ barcode: "OLD", imageUrl: "https://old" }), display))
      .toMatchObject({ barcode: "0850041234567", imageUrl: "https://cdn.example/sleeves.jpg" });
  });

  it("keeps a started line's own values and only fills gaps", () => {
    expect(withScanDisplay(line({ status: "in_progress", barcode: "OWN", imageUrl: null }), display))
      .toMatchObject({ barcode: "OWN", imageUrl: "https://cdn.example/sleeves.jpg" });
  });

  it("leaves a line with no catalog match unchanged", () => {
    const unknown = line({ sku: "UNKNOWN" });
    expect(withScanDisplay(unknown, display)).toBe(unknown);
  });
});

describe("picker payloads carry barcode and photo", () => {
  it("adds them to the pick queue without moving the planned bin, one lookup per SKU", async () => {
    const { service, storage } = fixture();
    const order = (id: number) => ({ id, orderNumber: `#${id}`, warehouseId: 1, warehouseStatus: "ready", onHold: 0,
      assignedPickerId: null, startedAt: null, items: [line({ id: id * 10, orderId: id })] });
    storage.getPickQueueOrders.mockResolvedValue([order(63776), order(63777)]);

    const queue = await service.getPickQueue();

    for (const queued of queue as any[]) {
      expect(queued.items[0]).toMatchObject({
        barcode: "0850041234567",
        imageUrl: "https://cdn.example/sleeves.jpg",
        location: "C-11",
        sourcePlan: { status: "ready", locationCode: "C-11", warehouseLocationId: 11 },
      });
    }
    // One set-based read for the whole queue, never a lookup per SKU.
    expect(storage.getScanDisplayBySkus).toHaveBeenCalledTimes(1);
    expect(storage.getScanDisplayBySkus).toHaveBeenCalledWith(["EG-SLV-PF-P100"]);
    expect(storage.getBinLocationFromInventoryBySku).not.toHaveBeenCalled();
  });

  it("adds them to a single picker order", async () => {
    const { service } = fixture();
    const order = await service.getPickerOrder(63776);
    expect(order.items[0]).toMatchObject({ barcode: "0850041234567", imageUrl: "https://cdn.example/sleeves.jpg", location: "C-11" });
  });

  it("does not look up a catalog photo for an unmapped line", async () => {
    const { service, storage } = fixture();
    storage.getOrderItems.mockResolvedValue([line({ sku: "UNKNOWN", location: "UNASSIGNED" })]);
    await service.getPickerOrder(63776);
    expect(storage.getScanDisplayBySkus).not.toHaveBeenCalled();
  });

  it("still serves the queue, without photos, when the photo read fails", async () => {
    const { service, storage } = fixture();
    storage.getPickQueueOrders.mockResolvedValue([{ id: 63776, orderNumber: "#63776", warehouseId: 1,
      warehouseStatus: "ready", onHold: 0, assignedPickerId: null, startedAt: null, items: [line()] }]);
    storage.getScanDisplayBySkus.mockRejectedValueOnce(new Error("statement timeout"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queue = await service.getPickQueue();
    expect((queue as any[])[0].items[0]).toMatchObject({ location: "C-11", barcode: null, imageUrl: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("\"action\":\"picker_scan_display\""));
    warn.mockRestore();
  });

  it("matches catalog SKUs case-insensitively", async () => {
    const { service, storage } = fixture();
    storage.getOrderItems.mockResolvedValue([line({ sku: "eg-slv-pf-p100" })]);
    const order = await service.getPickerOrder(63776);
    expect(order.items[0]).toMatchObject({ barcode: "0850041234567" });
  });

  it("adds them to the claim response the gun builds its picking screen from", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/orders/picking.use-cases.ts"), "utf8");
    const claimResponse = source.slice(source.indexOf('actionType: "order_claimed"'), source.indexOf("return { order, items: plannedItems };"));
    expect(claimResponse).toContain("withScanDisplay(item, scanDisplay)");
  });
});
