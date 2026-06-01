import { describe, it, expect, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

/**
 * Phase 4 (H4): Receipt idempotency — replayed receiveInventory calls
 * for the same (receivingOrderId, productVariantId, warehouseLocationId)
 * must skip without double-incrementing on-hand.
 */

function makeHarness() {
  const mockStorage: any = {
    upsertInventoryLevel: vi.fn(() =>
      Promise.resolve({ id: 1, variantQty: 10, reservedQty: 0, pickedQty: 0 }),
    ),
    adjustInventoryLevel: vi.fn(() => Promise.resolve()),
    createInventoryTransaction: vi.fn((t: any) =>
      Promise.resolve({ id: 1, ...t }),
    ),
  };

  let existingRows: any[] = [];

  const mockDb: any = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
    })),
    transaction: async (fn: any) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
        })),
        execute: vi.fn().mockImplementation(() =>
          Promise.resolve({ rows: existingRows }),
        ),
      };
      return fn(tx);
    },
  };

  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, mockStorage, setExistingRows: (rows: any[]) => { existingRows = rows; } };
}

describe("Receipt idempotency (H4)", () => {
  it("processes receipt normally when no prior row exists", async () => {
    const { uc, mockStorage, setExistingRows } = makeHarness();
    setExistingRows([]);

    await uc.receiveInventory({
      productVariantId: 1,
      warehouseLocationId: 5,
      qty: 10,
      referenceId: "RCV-1-batch",
      receivingOrderId: 100,
    });

    expect(mockStorage.adjustInventoryLevel).toHaveBeenCalledWith(
      1,
      { variantQty: 10 },
      expect.anything(),
    );
    expect(mockStorage.createInventoryTransaction).toHaveBeenCalledTimes(1);
  });

  it("skips mutation when receipt already exists (idempotent replay)", async () => {
    const { uc, mockStorage, setExistingRows } = makeHarness();
    setExistingRows([{ id: 999 }]);

    await uc.receiveInventory({
      productVariantId: 1,
      warehouseLocationId: 5,
      qty: 10,
      referenceId: "RCV-1-batch",
      receivingOrderId: 100,
    });

    expect(mockStorage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(mockStorage.createInventoryTransaction).not.toHaveBeenCalled();
  });

  it("still processes if receivingOrderId is not provided (direct receive)", async () => {
    const { uc, mockStorage } = makeHarness();

    await uc.receiveInventory({
      productVariantId: 1,
      warehouseLocationId: 5,
      qty: 10,
      referenceId: "manual-receive",
    });

    expect(mockStorage.adjustInventoryLevel).toHaveBeenCalled();
  });

  it("catches 23505 receipt_dedup constraint as belt-and-suspenders", async () => {
    const { uc, mockStorage, setExistingRows } = makeHarness();
    setExistingRows([]);

    const dupError: any = new Error("duplicate key");
    dupError.code = "23505";
    dupError.constraint = "uq_inventory_transactions_receipt_dedup";
    mockStorage.createInventoryTransaction.mockRejectedValueOnce(dupError);

    await expect(
      uc.receiveInventory({
        productVariantId: 1,
        warehouseLocationId: 5,
        qty: 10,
        referenceId: "RCV-1-batch",
        receivingOrderId: 100,
      }),
    ).resolves.toBeUndefined();
  });
});
