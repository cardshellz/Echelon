import { describe, it, expect, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

/**
 * Phase 3 (M1/M2): reserveForOrder must be idempotent — a duplicate call
 * for the same (orderId, orderItemId) should succeed silently without
 * double-incrementing reservedQty.
 */

function makeHarness() {
  const levels = new Map<string, any>();
  const txns: any[] = [];

  const mockStorage: any = {
    upsertInventoryLevel: vi.fn(
      (params: { productVariantId: number; warehouseLocationId: number }) => {
        const key = `${params.productVariantId}:${params.warehouseLocationId}`;
        if (!levels.has(key)) {
          levels.set(key, {
            id: 1,
            productVariantId: params.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
            variantQty: 10,
            reservedQty: 0,
            pickedQty: 0,
          });
        }
        return Promise.resolve(levels.get(key));
      },
    ),
    adjustInventoryLevel: vi.fn(
      (_id: number, delta: Record<string, number>) => {
        return Promise.resolve();
      },
    ),
    createInventoryTransaction: vi.fn((t: any) => {
      txns.push(t);
      return Promise.resolve({ id: txns.length, ...t });
    }),
  };

  const executeFn = vi.fn().mockResolvedValue({ rows: [] });
  const mockDb: any = {
    transaction: async (fn: any) => {
      const tx = { execute: executeFn };
      return fn(tx);
    },
  };

  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, mockStorage, txns, executeFn };
}

describe("InventoryUseCases.reserveForOrder idempotency (M1/M2)", () => {
  it("reserves normally on first call (no existing row)", async () => {
    const { uc, mockStorage, txns, executeFn } = makeHarness();
    executeFn.mockResolvedValue({ rows: [] });

    const result = await uc.reserveForOrder({
      productVariantId: 1,
      warehouseLocationId: 2,
      qty: 3,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toBe(true);
    expect(mockStorage.adjustInventoryLevel).toHaveBeenCalledWith(
      1,
      { reservedQty: 3 },
      expect.anything(),
    );
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      transactionType: "reserve",
      orderId: 100,
      orderItemId: 200,
    });
  });

  it("skips mutation if reserve row already exists (idempotent)", async () => {
    const { uc, mockStorage, txns, executeFn } = makeHarness();
    executeFn.mockResolvedValue({ rows: [{ id: 999 }] });

    const result = await uc.reserveForOrder({
      productVariantId: 1,
      warehouseLocationId: 2,
      qty: 3,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toBe(true);
    expect(mockStorage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(txns).toHaveLength(0);
  });

  it("catches 23505 reserve_dedup constraint as belt-and-suspenders", async () => {
    const { uc, mockStorage, executeFn } = makeHarness();
    executeFn.mockResolvedValue({ rows: [] });

    const dupError: any = new Error("duplicate key");
    dupError.code = "23505";
    dupError.constraint = "uq_inventory_transactions_reserve_dedup";
    mockStorage.createInventoryTransaction.mockRejectedValueOnce(dupError);

    const result = await uc.reserveForOrder({
      productVariantId: 1,
      warehouseLocationId: 2,
      qty: 3,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toBe(true);
  });

  it("re-throws non-dedup unique constraint violations", async () => {
    const { uc, mockStorage, executeFn } = makeHarness();
    executeFn.mockResolvedValue({ rows: [] });

    const otherError: any = new Error("some other constraint");
    otherError.code = "23505";
    otherError.constraint = "something_else";
    mockStorage.createInventoryTransaction.mockRejectedValueOnce(otherError);

    await expect(
      uc.reserveForOrder({
        productVariantId: 1,
        warehouseLocationId: 2,
        qty: 3,
        orderId: 100,
        orderItemId: 200,
      }),
    ).rejects.toThrow("some other constraint");
  });
});
