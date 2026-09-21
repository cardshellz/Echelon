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
    storage.getPickQueueOrders.mockResolvedValue([{ id: 1, combinedGroupId: 69, items: [{
      id: 2, sku: "REUSED", requiresShipping: 1, status: "pending", quantity: 1,
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
    const lines = [
      { id: 1, sku: "SKU", location: "A", quantity: 1 },
      { id: 2, sku: "SKU", location: "A", quantity: 1 },
      { id: 3, sku: "SKU", location: "A", quantity: 2 },
      { id: 4, sku: "SKU", location: "B", quantity: 1 },
    ];
    const result = await (service as any)._buildReplenPredictions(lines, new Map());
    expect(storage.getProductVariantBySku).toHaveBeenCalledTimes(1);
    expect(replen.predictReplenAfterPick).toHaveBeenCalledTimes(3);
    expect(result.get(1)).toEqual(result.get(2));
    expect(result.get(3)).toMatchObject({ postPickQty: 18 });
    expect(result.get(4)).toMatchObject({ sourceLocationCode: "2" });
    await (service as any)._buildReplenPredictions(lines, new Map());
    expect(replen.predictReplenAfterPick).toHaveBeenCalledTimes(6);
  });
  it("does no location or replenishment reads for an empty queue", async () => {
    const { service, storage, replen } = fixture();
    await service.getPickQueue();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(replen.predictReplenAfterPick).not.toHaveBeenCalled();
  });
});
