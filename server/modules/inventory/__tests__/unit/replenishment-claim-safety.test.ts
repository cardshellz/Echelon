import { describe, expect, it, vi } from "vitest";

import {
  InventoryUseCases,
  ReplenishmentInventoryConflictError,
} from "../../application/inventory.use-cases";

function locationChain(row: Record<string, unknown>) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [row]),
  };
}

function caseBreakFixture(sourceLevel: { variantQty: number; reservedQty: number }) {
  const source = {
    id: 11,
    code: "CASE-01",
    isActive: 1,
    warehouseId: 1,
    cycleCountFreezeId: null,
  };
  const target = {
    id: 12,
    code: "PICK-01",
    isActive: 1,
    warehouseId: 1,
    cycleCountFreezeId: null,
  };
  let selectCount = 0;
  const tx = {
    select: vi.fn(() => locationChain(selectCount++ === 0 ? source : target)),
    update: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
  };
  const db = {
    transaction: vi.fn(async (work: (activeTx: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const storage = {
    lockInventoryLevel: vi.fn(async () => ({
      id: 21,
      warehouseLocationId: 11,
      productVariantId: 100,
      pickedQty: 0,
      packedQty: 0,
      backorderQty: 0,
      updatedAt: new Date("2026-09-03T12:00:00.000Z"),
      ...sourceLevel,
    })),
    upsertInventoryLevel: vi.fn(async () => ({
      id: 22,
      warehouseLocationId: 12,
      productVariantId: 101,
      variantQty: 5,
      reservedQty: 2,
      pickedQty: 0,
      packedQty: 0,
      backorderQty: 0,
      updatedAt: new Date("2026-09-03T12:00:00.000Z"),
    })),
    adjustInventoryLevel: vi.fn(async () => null),
    createInventoryTransaction: vi.fn(async (input: Record<string, unknown>) => ({ id: 1, ...input })),
  };
  const adjustLots = vi.fn(async () => ({
    consumedCostCents: 500,
    consumedQty: 1,
    consumedPoCostMills: BigInt(49_001),
    consumedPackagingCostMills: BigInt(999),
    consumedLandedCostMills: BigInt(0),
    consumedCostProvisional: false,
  }));
  const createLot = vi.fn(async (input: Record<string, unknown>) => ({ id: 31, ...input }));
  const lotService = {
    withTx: vi.fn(() => ({ adjustLots, createLot })),
  };
  const inventory = new InventoryUseCases(db as any, storage as any, lotService as any);

  return { adjustLots, createLot, db, inventory, storage, tx };
}

const command = {
  taskId: 700,
  replenMethod: "case_break",
  sourceVariant: { id: 100, productId: 10, unitsPerVariant: 100 },
  pickVariant: { id: 101, productId: 10, unitsPerVariant: 10 },
  fromLocationId: 11,
  toLocationId: 12,
  qtySourceUnits: 1,
  qtyTargetUnits: 100,
  userId: "system:auto-replen",
  occurredAt: new Date("2026-09-03T12:00:00.000Z"),
};

describe("InventoryUseCases claim-safe replenishment", () => {
  it("fails closed when exact FIFO lot accounting is unavailable", async () => {
    const inventory = new InventoryUseCases({} as any, {} as any, null);

    await expect(inventory.executeReplenishmentMove({
      taskId: 701,
      replenMethod: "full_case",
      sourceVariant: { id: 100, productId: 10, unitsPerVariant: 10 },
      pickVariant: { id: 100, productId: 10, unitsPerVariant: 10 },
      fromLocationId: 11,
      toLocationId: 12,
      qtySourceUnits: 2,
      qtyTargetUnits: 20,
    })).rejects.toMatchObject({
      code: "REPLENISHMENT_LOT_SERVICE_UNAVAILABLE",
      context: expect.objectContaining({ taskId: 701, replenMethod: "full_case" }),
    } satisfies Partial<ReplenishmentInventoryConflictError>);
  });

  it("routes a direct replenishment through transfer with task-owned audit identity", async () => {
    const inventory = new InventoryUseCases({} as any, {} as any, {} as any);
    const deferUntilCommit = vi.fn((_effect: () => Promise<void>) => undefined);
    const transfer = vi.spyOn(inventory, "transfer").mockResolvedValue({
      reservedMoved: 0,
      orderItemsRepointed: 0,
    });

    await expect(inventory.executeReplenishmentMove({
      taskId: 702,
      replenMethod: "full_case",
      sourceVariant: { id: 100, productId: 10, unitsPerVariant: 10 },
      pickVariant: { id: 100, productId: 10, unitsPerVariant: 10 },
      fromLocationId: 11,
      toLocationId: 12,
      qtySourceUnits: 2,
      qtyTargetUnits: 20,
      userId: "system:auto-replen",
      notes: "Replen task #702 (full_case)",
      deferUntilCommit,
    })).resolves.toEqual({ movedBaseUnits: 20, qtyPickUnits: 2 });

    expect(transfer).toHaveBeenCalledWith({
      productVariantId: 100,
      fromLocationId: 11,
      toLocationId: 12,
      qty: 2,
      userId: "system:auto-replen",
      notes: "Replen task #702 (full_case)",
      referenceType: "replenishment_task",
      referenceId: "702",
      deferUntilCommit,
    });
  });

  it("fails before any mutation when only claim-reserved source stock remains", async () => {
    const fixture = caseBreakFixture({ variantQty: 5, reservedQty: 5 });

    await expect(fixture.inventory.executeReplenishmentMove(command)).rejects.toMatchObject({
      code: "REPLENISHMENT_RESERVED_STOCK_PROTECTED",
      context: expect.objectContaining({
        requestedQty: 1,
        onHandQty: 5,
        reservedQty: 5,
        availableQty: 0,
      }),
    } satisfies Partial<ReplenishmentInventoryConflictError>);

    expect(fixture.adjustLots).not.toHaveBeenCalled();
    expect(fixture.storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(fixture.storage.createInventoryTransaction).not.toHaveBeenCalled();
  });

  it("consumes only unreserved FIFO stock and preserves exact mill value in output layers", async () => {
    const fixture = caseBreakFixture({ variantQty: 5, reservedQty: 4 });
    const postCommitEffects: Array<() => Promise<void>> = [];

    await expect(fixture.inventory.executeReplenishmentMove({
      ...command,
      deferUntilCommit: (effect) => postCommitEffects.push(effect),
    })).resolves.toEqual({ movedBaseUnits: 100, qtyPickUnits: 10 });

    expect(fixture.adjustLots).toHaveBeenCalledWith({
      productVariantId: 100,
      warehouseLocationId: 11,
      qtyDelta: -1,
      notes: "Replen task #700 case break",
    });
    expect(fixture.storage.adjustInventoryLevel).toHaveBeenNthCalledWith(1, 21, { variantQty: -1 }, fixture.tx);
    expect(fixture.storage.adjustInventoryLevel).toHaveBeenNthCalledWith(2, 22, { variantQty: 10 }, fixture.tx);
    expect(fixture.createLot).toHaveBeenCalledTimes(3);

    const outputValueMills = fixture.createLot.mock.calls.reduce(
      (total, [lot]) => total + BigInt(Number(lot.unitCostMills)) * BigInt(Number(lot.qty)),
      BigInt(0),
    );
    expect(outputValueMills).toBe(BigInt(50_000));
    expect(fixture.storage.createInventoryTransaction).toHaveBeenCalledTimes(2);
    expect(postCommitEffects).toHaveLength(1);
  });
});
