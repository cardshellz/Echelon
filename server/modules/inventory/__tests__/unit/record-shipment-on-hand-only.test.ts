import { describe, expect, it, vi } from "vitest";

/**
 * SHIP-BEFORE-PICK FALLBACK: when a shipment ships before it was ever picked,
 * recordShipment is called with `deductFromOnHandOnly: true`. A never-picked
 * item has no picked pool of its own, so it must deduct from on-hand and
 * release its reservation — NOT draw down the location's shared picked pool
 * (which belongs to other, actually-picked orders).
 */
describe("InventoryUseCases.recordShipment — deductFromOnHandOnly", () => {
  function harness() {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const tx = { execute: vi.fn(async () => ({ rows: [] })) };
    const rootDb = {
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(async (fn: (t: any) => Promise<unknown>) => fn(tx)),
    };
    const storage = {
      // The location HAS a picked pool (2) from OTHER orders + reserved (3).
      lockInventoryLevel: vi.fn(async () => ({
        id: 10,
        warehouseLocationId: 20,
        productVariantId: 30,
        variantQty: 5,
        reservedQty: 3,
        pickedQty: 2,
        packedQty: 0,
        backorderQty: 0,
        updatedAt: new Date(),
      })),
      adjustInventoryLevel: vi.fn(async () => null),
      createInventoryTransaction: vi.fn(async () => undefined),
    } as any;
    const shipFromLots = vi.fn(async () => undefined);
    const lotService = { withTx: vi.fn(() => ({ shipFromLots })) };
    return { tx, rootDb, storage, lotService };
  }

  it("deducts on-hand + releases reservation, leaving the picked pool untouched", async () => {
    const { rootDb, storage, lotService, tx } = harness();
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 40,
      orderItemId: 50,
      shipmentId: "SHIP-1",
      userId: "tester",
      deductFromOnHandOnly: true,
    });

    // on-hand -2 and reservation released by min(reserved=3, qty=2)=2.
    expect(storage.adjustInventoryLevel).toHaveBeenCalledTimes(1);
    expect(storage.adjustInventoryLevel).toHaveBeenCalledWith(
      10,
      { variantQty: -2, reservedQty: -2 },
      tx,
    );
    // The shared picked pool (another order's) is NOT drawn down.
    const touchedPicked = storage.adjustInventoryLevel.mock.calls.some(
      ([, adj]: any[]) => adj && "pickedQty" in adj,
    );
    expect(touchedPicked).toBe(false);
  });

  it("by default (flag unset) still draws from the picked pool first", async () => {
    const { rootDb, storage, lotService, tx } = harness();
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 40,
      orderItemId: 50,
      shipmentId: "SHIP-2",
      userId: "tester",
    });

    // qty 2 fully covered by pickedQty 2 → picked pool drawn, on-hand untouched.
    expect(storage.adjustInventoryLevel).toHaveBeenCalledWith(10, { pickedQty: -2 }, tx);
    const touchedOnHand = storage.adjustInventoryLevel.mock.calls.some(
      ([, adj]: any[]) => adj && "variantQty" in adj,
    );
    expect(touchedOnHand).toBe(false);
  });

  it("deducts a concession only from unreserved on-hand inventory", async () => {
    const { rootDb, storage, lotService, tx } = harness();
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 40,
      shipmentId: "41",
      shipmentItemId: 60,
      userId: "tester",
      deductFromOnHandOnly: true,
      releaseReservation: false,
    });

    expect(storage.adjustInventoryLevel).toHaveBeenCalledWith(10, { variantQty: -2 }, tx);
  });

  it("refuses a concession that would consume another order's reserved stock", async () => {
    const { rootDb, storage, lotService } = harness();
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await expect(inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 3,
      orderId: 40,
      shipmentId: "41",
      shipmentItemId: 60,
      userId: "tester",
      deductFromOnHandOnly: true,
      releaseReservation: false,
    })).rejects.toThrow("Insufficient unreserved inventory");

    expect(storage.adjustInventoryLevel).not.toHaveBeenCalled();
  });

  it("uses the physical shipment item as the concession replay key", async () => {
    const { rootDb, storage, lotService, tx } = harness();
    tx.execute.mockImplementation(async (query: any) => {
      const text = (query?.queryChunks ?? [])
        .map((chunk: any) => Array.isArray(chunk?.value) ? chunk.value.join("") : "")
        .join("");
      return text.includes("FROM inventory.inventory_transactions")
        ? { rows: [{ id: 999 }] }
        : { rows: [] };
    });
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 1,
      orderId: 40,
      shipmentId: "41",
      shipmentItemId: 60,
      deductFromOnHandOnly: true,
      releaseReservation: false,
    });

    expect(storage.lockInventoryLevel).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});

describe("InventoryUseCases.recordReplacementShipmentFromAvailableInventory", () => {
  function replacementHarness(existingLocationId?: number) {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => {
        const query = {
          from: () => query,
          where: () => query,
          limit: async () => [{ cycleCountFreezeId: null }],
        };
        return query;
      }),
    };
    tx.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(existingLocationId ? { rows: [{ from_location_id: existingLocationId }] } : { rows: [] });
    if (!existingLocationId) {
      tx.execute.mockResolvedValueOnce({ rows: [{ warehouse_location_id: 21 }] });
    }

    const rootDb = {
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(async (fn: (t: any) => Promise<unknown>) => fn(tx)),
    };
    const storage = {
      lockInventoryLevel: vi.fn(async () => ({
        id: 10,
        warehouseLocationId: 21,
        productVariantId: 30,
        variantQty: 8,
        reservedQty: 3,
        pickedQty: 0,
        packedQty: 0,
        backorderQty: 0,
        updatedAt: new Date(),
      })),
      adjustInventoryLevel: vi.fn(async () => null),
      createInventoryTransaction: vi.fn(async () => undefined),
    } as any;
    const pickFromLots = vi.fn(async () => []);
    const shipFromLots = vi.fn(async () => undefined);
    const lotService = { withTx: vi.fn(() => ({ pickFromLots, shipFromLots })) };
    return { rootDb, storage, lotService, pickFromLots, shipFromLots };
  }

  it("allocates current unreserved stock, records a system pick, then ships it", async () => {
    const { rootDb, storage, lotService, pickFromLots, shipFromLots } = replacementHarness();
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30,
      qty: 2,
      warehouseId: 1,
      orderId: 40,
      orderItemId: 50,
      shipmentId: 60,
      shipmentItemId: 70,
      userId: "system:shipstation:v2",
    })).resolves.toEqual({ warehouseLocationId: 21, alreadyRecorded: false });

    expect(storage.lockInventoryLevel).toHaveBeenCalledWith(21, 30, expect.anything());
    expect(storage.adjustInventoryLevel).toHaveBeenNthCalledWith(1, 10, { variantQty: -2, pickedQty: 2 }, expect.anything());
    expect(storage.adjustInventoryLevel).toHaveBeenNthCalledWith(2, 10, { pickedQty: -2 }, expect.anything());
    expect(pickFromLots).toHaveBeenCalledWith(expect.objectContaining({
      qty: 2,
      recordOrderItemCosts: false,
      allowReservedStock: false,
    }));
    expect(shipFromLots).toHaveBeenCalledWith(expect.objectContaining({ qty: 2 }));
    expect(storage.createInventoryTransaction).toHaveBeenCalledTimes(2);
    expect(storage.createInventoryTransaction.mock.calls[0][0]).toEqual(expect.objectContaining({
      transactionType: "pick",
      shipmentItemId: 70,
      isImplicit: 1,
    }));
    expect(storage.createInventoryTransaction.mock.calls[1][0]).toEqual(expect.objectContaining({
      transactionType: "ship",
      shipmentItemId: 70,
      referenceId: "60",
    }));
  });

  it("does not allocate or deduct twice when the physical shipment item already posted", async () => {
    const { rootDb, storage, lotService, pickFromLots, shipFromLots } = replacementHarness(21);
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30,
      qty: 2,
      warehouseId: 1,
      orderId: 40,
      shipmentId: 60,
      shipmentItemId: 70,
    })).resolves.toEqual({ warehouseLocationId: 21, alreadyRecorded: true });

    expect(storage.lockInventoryLevel).not.toHaveBeenCalled();
    expect(storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(storage.createInventoryTransaction).not.toHaveBeenCalled();
    expect(pickFromLots).not.toHaveBeenCalled();
    expect(shipFromLots).not.toHaveBeenCalled();
  });

  it("rejects instead of consuming another order's reserved stock", async () => {
    const { rootDb, storage, lotService, pickFromLots, shipFromLots } = replacementHarness();
    storage.lockInventoryLevel.mockResolvedValueOnce({
      id: 10,
      warehouseLocationId: 21,
      productVariantId: 30,
      variantQty: 5,
      reservedQty: 5,
      pickedQty: 0,
      packedQty: 0,
      backorderQty: 0,
      updatedAt: new Date(),
    });
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const inventory = new InventoryUseCases(rootDb as any, storage, lotService as any, null as any);

    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30,
      qty: 1,
      warehouseId: 1,
      orderId: 40,
      shipmentId: 60,
      shipmentItemId: 70,
    })).rejects.toThrow("no active, pickable, unfrozen location");

    expect(storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(pickFromLots).not.toHaveBeenCalled();
    expect(shipFromLots).not.toHaveBeenCalled();
  });
});