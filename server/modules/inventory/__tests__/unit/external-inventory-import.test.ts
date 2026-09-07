import { describe, expect, it, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import type { ExternalInventoryImportDependencies, ExternalInventorySnapshot } from "../../application/external-inventory-source.contract";
import { warehouses } from "@shared/schema";

function harness(quantity = 8, reservedQty = 0) {
  const warehouse = { id: 35, code: "EXTERNAL", inventorySourceType: "channel", inventorySourceConfig: { channelId: 2 }, shopifyLocationId: null };
  let level = { id: 10, variantQty: 10, reservedQty, pickedQty: 0 };
  const events: string[] = [];
  const chain = () => {
    let rows: unknown[] = [];
    const query = {
      from: vi.fn((table: unknown) => { rows = table === warehouses ? [warehouse] : [{ id: 20, cycleCountFreezeId: null }]; return query; }),
      where: vi.fn(() => query), limit: vi.fn(() => query), for: vi.fn(() => query), set: vi.fn(() => query),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  const db = { select: vi.fn(chain), update: vi.fn(chain), insert: vi.fn(), execute: vi.fn(),
    transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => {
      const before = { ...level };
      try { await work(db); events.push("commit"); } catch (error) { level = before; throw error; }
    }) };
  const storage = {
    upsertInventoryLevel: vi.fn(async () => ({ ...level })),
    adjustInventoryLevel: vi.fn(async (_id: number, delta: { variantQty?: number }) => { level.variantQty += delta.variantQty ?? 0; }),
    createInventoryTransaction: vi.fn(async () => ({ id: 99 })),
  };
  const snapshot: ExternalInventorySnapshot = { channelId: 2, connectionId: 7, externalAccountId: "second.myshopify.com", externalLocationId: "20",
    items: [{ productVariantId: 1, externalInventoryItemId: "5", quantity }] };
  const dependencies: ExternalInventoryImportDependencies = {
    read: vi.fn(async () => snapshot), validateSnapshot: vi.fn(async () => undefined),
    withWarehouseLock: vi.fn(async (_id, work) => work()), clock: () => new Date("2026-09-07T00:00:00Z"),
  };
  const inventory = new InventoryUseCases(db as never, storage as never, null, null, dependencies);
  // Match the real callback boundary without sending provider notifications.
  vi.spyOn(inventory as never as { triggerNotifyChange: () => void }, "triggerNotifyChange").mockImplementation(() => { events.push("notify"); });
  return { inventory, db, storage, dependencies, snapshot, events, warehouse, currentQuantity: () => level.variantQty };
}

describe("external inventory import", () => {
  it("uses the configured source and replays the same observation without a second adjustment", async () => {
    const h = harness();
    const first = await h.inventory.syncWarehouse(35);
    const replay = await h.inventory.syncWarehouse(35);
    expect(first).toMatchObject({ synced: 1, skipped: 0, errors: [] });
    expect(replay.errors).toEqual([]);
    expect(h.dependencies.read).toHaveBeenCalledWith({ channelId: 2 }, null);
    expect(h.dependencies.withWarehouseLock).toHaveBeenCalledWith(35, expect.any(Function));
    expect(h.storage.adjustInventoryLevel).toHaveBeenCalledTimes(1);
    expect(h.currentQuantity()).toBe(8);
    expect(h.db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("never applies invalid quantity %s", async (quantity) => {
    const h = harness(quantity);
    expect((await h.inventory.syncWarehouse(35)).errors[0]).toContain("invalid quantities");
    expect(h.storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
  });
  it("protects reserved stock rather than forcing an adjustment", async () => {
    const h = harness(2, 3);
    expect((await h.inventory.syncWarehouse(35)).errors[0]).toContain("below reserved stock");
    expect(h.currentQuantity()).toBe(10);
    expect(h.storage.adjustInventoryLevel).not.toHaveBeenCalled();
  });
  it("records unmapped items for review without treating them as zero stock", async () => {
    const h = harness();
    h.snapshot.items[0].productVariantId = null;
    expect(await h.inventory.syncWarehouse(35)).toMatchObject({ synced: 0, skipped: 1, errors: ["Unmapped external inventory item 5"] });
    expect(h.storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(h.db.insert).not.toHaveBeenCalled();
  });
  it("rejects a mapping changed after readback before adjusting inventory", async () => {
    const h = harness();
    vi.mocked(h.dependencies.validateSnapshot).mockRejectedValue(new Error("Mapping changed"));
    expect((await h.inventory.syncWarehouse(35)).errors).toEqual(["Mapping changed"]);
    expect(h.storage.adjustInventoryLevel).not.toHaveBeenCalled();
  });
  it("rejects duplicate internal identities before any batch", async () => {
    const h = harness();
    h.snapshot.items.push({ productVariantId: 1, externalInventoryItemId: "6", quantity: 2 });
    expect((await h.inventory.syncWarehouse(35)).errors[0]).toContain("ambiguous identities");
    expect(h.db.transaction).not.toHaveBeenCalled();
  });
});
