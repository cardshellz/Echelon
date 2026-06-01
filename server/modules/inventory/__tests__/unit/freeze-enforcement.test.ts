import { describe, it, expect, vi } from "vitest";
import { InventoryUseCases, FreezeViolationError } from "../../application/inventory.use-cases";

/**
 * Phase 4 (H2): Freeze enforcement — receive, adjust, and transfer must
 * reject mutations on frozen locations (cycleCountFreezeId set).
 * Cycle-count adjustments (cycleCountId present) are the one exception.
 */

function makeHarness(opts: { frozen?: boolean } = {}) {
  const frozenId = opts.frozen ? 42 : null;

  const mockStorage: any = {
    upsertInventoryLevel: vi.fn(() =>
      Promise.resolve({ id: 1, variantQty: 10, reservedQty: 0, pickedQty: 0 }),
    ),
    adjustInventoryLevel: vi.fn(() => Promise.resolve()),
    lockInventoryLevel: vi.fn(() =>
      Promise.resolve({ id: 1, variantQty: 10, reservedQty: 0, pickedQty: 0 }),
    ),
    createInventoryTransaction: vi.fn((t: any) =>
      Promise.resolve({ id: 1, ...t }),
    ),
  };

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{
      id: 1,
      cycleCountFreezeId: frozenId,
      code: "A-01",
      isActive: 1,
      warehouseId: 1,
    }]),
  };

  const executeResult = { rows: [] as any[] };

  const mockDb: any = {
    select: vi.fn(() => selectChain),
    transaction: async (fn: any) => {
      const tx = {
        select: vi.fn(() => selectChain),
        execute: vi.fn().mockResolvedValue(executeResult),
      };
      return fn(tx);
    },
    execute: vi.fn().mockResolvedValue(executeResult),
  };

  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, mockStorage, executeResult };
}

describe("Freeze enforcement (H2)", () => {
  describe("receiveInventory", () => {
    it("throws FreezeViolationError when destination is frozen", async () => {
      const { uc } = makeHarness({ frozen: true });

      await expect(
        uc.receiveInventory({
          productVariantId: 1,
          warehouseLocationId: 5,
          qty: 10,
          referenceId: "RCV-1",
        }),
      ).rejects.toThrow(FreezeViolationError);
    });

    it("allows receive when destination is not frozen", async () => {
      const { uc, mockStorage } = makeHarness({ frozen: false });

      await uc.receiveInventory({
        productVariantId: 1,
        warehouseLocationId: 5,
        qty: 10,
        referenceId: "RCV-1",
      });

      expect(mockStorage.adjustInventoryLevel).toHaveBeenCalled();
    });
  });

  describe("adjustInventory", () => {
    it("throws FreezeViolationError for manual adjustments on frozen location", async () => {
      const { uc } = makeHarness({ frozen: true });

      await expect(
        uc.adjustInventory({
          productVariantId: 1,
          warehouseLocationId: 5,
          qtyDelta: -3,
          reason: "Manual fix",
        }),
      ).rejects.toThrow(FreezeViolationError);
    });

    it("allows cycle-count adjustments on frozen locations", async () => {
      const { uc, mockStorage } = makeHarness({ frozen: true });

      await uc.adjustInventory({
        productVariantId: 1,
        warehouseLocationId: 5,
        qtyDelta: -3,
        reason: "Cycle count variance",
        cycleCountId: 99,
      });

      expect(mockStorage.adjustInventoryLevel).toHaveBeenCalled();
    });
  });

  describe("transfer", () => {
    it("throws FreezeViolationError when source is frozen", async () => {
      const { uc } = makeHarness({ frozen: true });

      await expect(
        uc.transfer({
          productVariantId: 1,
          fromLocationId: 5,
          toLocationId: 6,
          qty: 3,
        }),
      ).rejects.toThrow(FreezeViolationError);
    });
  });
});
