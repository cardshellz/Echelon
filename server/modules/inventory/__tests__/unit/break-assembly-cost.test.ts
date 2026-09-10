import { describe, expect, it, vi } from "vitest";
// Explicit pre-opening compatibility fixture; real active package postings are
// exercised by quantity-ledger.integration.test.ts.
vi.mock("../../infrastructure/operational-quantity-posting", () => ({ openOperationalQuantityPosting: vi.fn(async () => null) }));

/**
 * COGS Phase 3: break/assembly must propagate cost from source lots to target.
 * When breaking 1 case ($10.00) into 10 packs, each pack should cost $1.00.
 */

function makeVariantDb(variantSequence: any[]) {
  // fetchVariant calls db.select().from(productVariants).where(eq(id, X))
  // which resolves as a thenable (no .limit). We return variants in the
  // order they'll be fetched (Promise.all preserves initiation order).
  let fetchIdx = 0;
  let lockIndex = 0;
  const lockedRows = [variantSequence[2], ...variantSequence.slice(0, 2).sort((a, b) => a.id-b.id)];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const v = variantSequence[fetchIdx++];
          const result = v ? [v] : [];
          return Object.assign(
            Promise.resolve(result),
            {
              limit: vi.fn().mockResolvedValue(result),
              innerJoin: vi.fn().mockReturnThis(),
            },
          );
        }),
        innerJoin: vi.fn().mockReturnThis(),
      })),
    })),
    transaction: vi.fn(async (fn: any) => fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ variantQty: 50 }]),
            for: vi.fn(async () => [lockedRows[lockIndex++]]),
          })),
        })),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
    })),
  } as any;
}

describe("BreakAssemblyUseCases — cost propagation", () => {
  it("break propagates source lot cost to target adjustment", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { BreakAssemblyUseCases } = await import("../../application/break-assembly.use-cases");

    const sourceVariant = {
      id: 1, productId: 100, name: "Case of 10", sku: "CASE-10",
      unitsPerVariant: 10, isActive: true, parentVariantId: 2,
    };
    const targetVariant = {
      id: 2, productId: 100, name: "Single Pack", sku: "PACK-1",
      unitsPerVariant: 1, isActive: true, parentVariantId: null,
    };

    const adjustCalls: any[] = [];
    const inventoryUseCases = {
      adjustInventory: vi.fn(async (params: any) => {
        adjustCalls.push(params);
        if (params.qtyDelta < 0) {
          return { orphanedQty: 0, consumedCostCents: 1000, consumedQty: 1, consumedLots: [{ lotId: 11, qty: 1 }], consumedPoCostMills: "100000", consumedPackagingCostMills: "0", consumedLandedCostMills: "0", consumedCostProvisional: false };
        }
        return { orphanedQty: 0, consumedCostCents: 0, consumedQty: 0 };
      }),
      withTx: vi.fn(function () { return this; }),
    };

    const db = makeVariantDb([sourceVariant, targetVariant, { inventoryStrategy: "physical_fungible" }]);

    const svc = new BreakAssemblyUseCases(db, inventoryUseCases as any);

    await svc.breakVariant({
      sourceVariantId: 1,
      targetVariantId: 2,
      warehouseLocationId: 20,
      sourceQty: 1,
      userId: "tester",
    });

    expect(adjustCalls).toHaveLength(2);
    expect(adjustCalls[0].qtyDelta).toBe(-1);
    expect(adjustCalls[0].productVariantId).toBe(1);
    // 1000 cents / 10 packs = 100 cents per pack
    expect(adjustCalls[1].qtyDelta).toBe(10);
    expect(adjustCalls[1].productVariantId).toBe(2);
    expect(adjustCalls[1].conversion).toMatchObject({ sourceLots: [{lotId:11,qty:1}], productMills: BigInt(100000), packagingMills: BigInt(0), landedMills: BigInt(0), provisional: false });
    expect(adjustCalls[1].unitCostCents).toBeUndefined();
  });

  it("assembly propagates source cost to assembled target", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { BreakAssemblyUseCases } = await import("../../application/break-assembly.use-cases");

    const sourceVariant = {
      id: 2, productId: 100, name: "Single Pack", sku: "PACK-1",
      unitsPerVariant: 1, isActive: true, parentVariantId: 1,
    };
    const targetVariant = {
      id: 1, productId: 100, name: "Case of 10", sku: "CASE-10",
      unitsPerVariant: 10, isActive: true, parentVariantId: null,
    };

    const adjustCalls: any[] = [];
    const inventoryUseCases = {
      adjustInventory: vi.fn(async (params: any) => {
        adjustCalls.push(params);
        if (params.qtyDelta < 0) {
          return { orphanedQty: 0, consumedCostCents: 1000, consumedQty: 10, consumedLots: [{ lotId: 11, qty: 10 }], consumedPoCostMills: "100000", consumedPackagingCostMills: "0", consumedLandedCostMills: "0", consumedCostProvisional: false };
        }
        return { orphanedQty: 0, consumedCostCents: 0, consumedQty: 0 };
      }),
      withTx: vi.fn(function () { return this; }),
    };

    const db = makeVariantDb([sourceVariant, targetVariant, { inventoryStrategy: "physical_fungible" }]);

    const svc = new BreakAssemblyUseCases(db, inventoryUseCases as any);

    await svc.assembleVariant({
      sourceVariantId: 2,
      targetVariantId: 1,
      warehouseLocationId: 20,
      targetQty: 1,
      userId: "tester",
    });

    expect(adjustCalls).toHaveLength(2);
    expect(adjustCalls[0].qtyDelta).toBe(-10);
    // 1000 cents / 1 case = 1000 cents per case
    expect(adjustCalls[1].qtyDelta).toBe(1);
    expect(adjustCalls[1].conversion).toMatchObject({ sourceLots: [{lotId:11,qty:10}], productMills: BigInt(100000), packagingMills: BigInt(0), landedMills: BigInt(0), provisional: false });
    expect(inventoryUseCases.withTx).toHaveBeenCalledTimes(1);
  });

  it.each(["recipe_managed", "physical_only"] as const)(
    "blocks direct conversion for %s products",
    async (inventoryStrategy) => {
      process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
      const { BreakAssemblyUseCases, InventoryConversionStrategyError } = await import(
        "../../application/break-assembly.use-cases"
      );
      const sourceVariant = {
        id: 1, productId: 100, name: "Case of 10", sku: "CASE-10",
        unitsPerVariant: 10, isActive: true, parentVariantId: 2,
      };
      const targetVariant = {
        id: 2, productId: 100, name: "Single Pack", sku: "PACK-1",
        unitsPerVariant: 1, isActive: true, parentVariantId: null,
      };
      const inventoryUseCases = {
        adjustInventory: vi.fn(),
        withTx: vi.fn(function () { return this; }),
      };
      const db = makeVariantDb([sourceVariant, targetVariant, { inventoryStrategy }]);
      const svc = new BreakAssemblyUseCases(db, inventoryUseCases as any);

      await expect(svc.breakVariant({
        sourceVariantId: 1,
        targetVariantId: 2,
        warehouseLocationId: 20,
        sourceQty: 1,
      })).rejects.toEqual(expect.objectContaining({
        code: "DIRECT_CONVERSION_NOT_ALLOWED",
        productId: 100,
        inventoryStrategy,
      }));
      expect(InventoryConversionStrategyError).toBeDefined();
      expect(inventoryUseCases.adjustInventory).not.toHaveBeenCalled();
    },
  );
});
