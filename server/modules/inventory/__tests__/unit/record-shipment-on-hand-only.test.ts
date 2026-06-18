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
});
