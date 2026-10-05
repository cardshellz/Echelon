import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

function fixture() {
  const storage = {
    getPickQueueOrders: vi.fn(async () => []),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A" }, { id: 2, code: "B" }]),
    getProductVariantBySku: vi.fn(async () => ({ id: 10 })),
  };
  const replen = { predictReplenAfterPick: vi.fn(async (_variant: number, location: number, qty: number) => ({ postPickQty: 20 - qty, sourceLocationCode: String(location) })) };
  const service = new PickingUseCases({} as any, {} as any, replen as any, storage as any);
  return { service, storage, replen };
}

describe("pick queue read load", () => {
  it("keeps product-only items visible without looking up another SKU's stock or replenishment", async () => {
    const { service, storage, replen } = fixture();
    storage.getPickQueueOrders.mockResolvedValue([{ id: 1, orderNumber: "QUEUE", warehouseId: 1,
      warehouseStatus: "ready", onHold: 0, assignedPickerId: null, startedAt: null, combinedGroupId: 69, items: [{
      id: 2, orderId: 1, productId: null, name: "Product only", sku: "REUSED", requiresShipping: 1,
      status: "pending", quantity: 1, pickedQuantity: 0, fulfilledQuantity: 0, onHold: false,
      catalogProductId: 3, inventoryTracking: false, location: "UNASSIGNED",
    }] }] as never);
    const result = await service.getPickQueue();
    expect(result[0].items[0]).toMatchObject({ id: 2, location: "UNASSIGNED", inventoryTracking: false });
    expect(storage.getProductVariantBySku).not.toHaveBeenCalled();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(replen.predictReplenAfterPick).not.toHaveBeenCalled();
  });

  it("shares only in-flight reads and refreshes after completion", async () => {
    const { service, storage } = fixture();
    const first = service.getPickQueue();
    const second = service.getPickQueue();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(storage.getPickQueueOrders).toHaveBeenCalledTimes(1);
    await service.getPickQueue();
    expect(storage.getPickQueueOrders).toHaveBeenCalledTimes(2);
  });
  it("clears failed reads and separates warehouse scopes", async () => {
    const { service, storage } = fixture();
    storage.getPickQueueOrders.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.getPickQueue()).rejects.toThrow("database unavailable");
    await Promise.all([service.getPickQueue(1), service.getPickQueue(2)]);
    expect(storage.getPickQueueOrders).toHaveBeenCalledTimes(3);
  });
  it("evaluates repeated identical previews once without conflating bins or quantities", async () => {
    const { service, storage, replen } = fixture();
    const sourcePlan = { status: "ready", productVariantId: 10, warehouseLocationId: 1, warehouseId: 1, locationCode: "A" };
    const item = { sku: "SKU", location: "A", pickedQuantity: 0, requiresShipping: 1, status: "pending", sourcePlan };
    const lines = [
      { ...item, id: 1, quantity: 1 },
      { ...item, id: 2, quantity: 1 },
      { ...item, id: 3, quantity: 2 },
      { ...item, id: 4, quantity: 1, location: "B", sourcePlan: { ...sourcePlan, warehouseLocationId: 2, locationCode: "B" } },
      { ...item, id: 5, quantity: 1, sourcePlan: { ...sourcePlan, productVariantId: 11 } },
    ];
    const result = await (service as any)._buildReplenPredictions(lines);
    expect(storage.getProductVariantBySku).not.toHaveBeenCalled();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(replen.predictReplenAfterPick).toHaveBeenCalledTimes(4);
    expect(replen.predictReplenAfterPick).toHaveBeenCalledWith(11, 1, 1);
    expect(result.get(1)).toEqual(result.get(2));
    expect(result.get(3)).toMatchObject({ postPickQty: 18 });
    expect(result.get(4)).toMatchObject({ sourceLocationCode: "2" });
    await (service as any)._buildReplenPredictions(lines);
    expect(replen.predictReplenAfterPick).toHaveBeenCalledTimes(8);
  });
  it("does no location or replenishment reads for an empty queue", async () => {
    const { service, storage, replen } = fixture();
    await service.getPickQueue();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(replen.predictReplenAfterPick).not.toHaveBeenCalled();
  });
});
