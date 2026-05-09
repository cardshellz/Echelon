import { describe, expect, it, vi } from "vitest";

describe("InventoryUseCases.withTx", () => {
  it("reuses the caller transaction for pick mutations and ledger writes", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryUseCases } = await import("../application/inventory.use-cases");

    const outerTx = {
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn(),
    };

    const rootDb = {
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(async () => {
        throw new Error("root transaction should not be opened by tx-bound clone");
      }),
    };

    const storage = {
      lockInventoryLevel: vi.fn(async (_locationId: number, _variantId: number, tx: any) => {
        expect(tx).toBe(outerTx);
        return {
          id: 10,
          warehouseLocationId: 20,
          productVariantId: 30,
          variantQty: 5,
          reservedQty: 1,
          pickedQty: 0,
          packedQty: 0,
          backorderQty: 0,
          updatedAt: new Date(),
        };
      }),
      adjustInventoryLevel: vi.fn(async (_levelId: number, _deltas: any, tx: any) => {
        expect(tx).toBe(outerTx);
        return {
          id: 10,
          warehouseLocationId: 20,
          productVariantId: 30,
          variantQty: 4,
          reservedQty: 0,
          pickedQty: 1,
          packedQty: 0,
          backorderQty: 0,
          updatedAt: new Date(),
        };
      }),
      createInventoryTransaction: vi.fn(async (_txn: any, tx: any) => {
        expect(tx).toBe(outerTx);
      }),
    } as any;

    const txBoundInventory = new InventoryUseCases(rootDb as any, storage).withTx(outerTx);

    const picked = await txBoundInventory.pickItem({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 1,
      orderId: 40,
      orderItemId: 50,
      userId: "tester",
    });

    expect(picked).toBe(true);
    expect(rootDb.transaction).not.toHaveBeenCalled();
    expect(storage.lockInventoryLevel).toHaveBeenCalledTimes(1);
    expect(storage.adjustInventoryLevel).toHaveBeenCalledWith(
      10,
      { variantQty: -1, pickedQty: 1, reservedQty: -1 },
      outerTx,
    );
    expect(storage.createInventoryTransaction).toHaveBeenCalledTimes(1);
  });
});
