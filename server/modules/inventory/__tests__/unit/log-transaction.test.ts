import { describe, it, expect, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

/**
 * Phase 1 (C7): logTransaction was referenced by returns-restock, CSV upload,
 * bin-count, and SKU-conversion paths but never existed on InventoryUseCases —
 * a latent runtime crash. These tests pin the public method that now exists:
 * it delegates straight to storage.createInventoryTransaction and returns the
 * persisted row. (See returns.service.ts:136/187, picking.use-cases.ts:2180.)
 */
function makeHarness() {
  const txns: any[] = [];
  const mockStorage: any = {
    createInventoryTransaction: vi.fn((t: any) => {
      txns.push(t);
      return Promise.resolve({ id: 123, ...t });
    }),
  };
  const mockDb: any = { transaction: (fn: any) => fn({}) };
  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, mockStorage, txns };
}

describe("InventoryUseCases.logTransaction (C7)", () => {
  it("delegates to storage.createInventoryTransaction and returns the row", async () => {
    const { uc, mockStorage, txns } = makeHarness();

    const result = await uc.logTransaction({
      productVariantId: 7,
      toLocationId: 5,
      transactionType: "return",
      variantQtyDelta: 4,
      sourceState: "returned",
      targetState: "on_hand",
      referenceType: "order",
      referenceId: "1001",
    } as any);

    expect(mockStorage.createInventoryTransaction).toHaveBeenCalledTimes(1);
    expect(txns[0]).toMatchObject({
      productVariantId: 7,
      transactionType: "return",
      variantQtyDelta: 4,
    });
    expect(result).toMatchObject({ id: 123, transactionType: "return" });
  });

  it("is callable on a tx-scoped clone (withTx) for atomic compound flows", async () => {
    const { uc, mockStorage } = makeHarness();
    const scoped = uc.withTx({} as any);
    await scoped.logTransaction({
      productVariantId: 1,
      transactionType: "cycle_count",
      variantQtyDelta: 0,
    } as any);
    expect(mockStorage.createInventoryTransaction).toHaveBeenCalledTimes(1);
  });
});
