import { describe, expect, it, vi } from "vitest";

vi.mock("../../notifications/notifications.service", () => ({
  notify: vi.fn(async () => undefined),
}));
vi.mock("../../warehouse/settings.resolver", () => ({
  getSettingsForWarehouse: vi.fn(async () => null),
}));

import { ReplenishmentUseCases } from "../application/replenishment.use-cases";
import {
  cycleCountItems,
  cycleCounts,
  inventoryLevels,
  locationReplenConfig,
  productVariants,
  replenRules,
  replenTasks,
  replenTierDefaults,
  warehouseLocations,
} from "@shared/schema";

function makeDb() {
  const inserts: Array<{ table: unknown; value: any }> = [];
  const updates: Array<{ table: unknown; value: any }> = [];
  const selectCounts = new Map<unknown, number>();
  const state: { insertedReplenTask?: any } = {};

  const pickVariant = {
    id: 100,
    sku: "SKU-1",
    name: "Each",
    productId: 10,
    hierarchyLevel: 1,
    unitsPerVariant: 1,
  };
  const pickLocation = { id: 1, code: "A-01", warehouseId: 7, parentLocationId: null };
  const sourceLocation = { id: 2, code: "B-01", warehouseId: 7, parentLocationId: null };
  const sourceLevel = { id: 22, warehouseLocationId: 2, productVariantId: 100, variantQty: 5 };

  const selectRows = (table: unknown) => {
    const count = selectCounts.get(table) ?? 0;
    selectCounts.set(table, count + 1);
    if (table === replenTasks) return state.insertedReplenTask ? [state.insertedReplenTask] : [];
    if (table === productVariants) return [pickVariant];
    if (table === warehouseLocations) return count === 0 ? [pickLocation] : [sourceLocation];
    if (table === locationReplenConfig) return [];
    if (table === replenRules) return [];
    if (table === replenTierDefaults) return [];
    if (table === inventoryLevels) return [sourceLevel];
    return [];
  };

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: vi.fn(async () => selectRows(table)),
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: any) => {
        inserts.push({ table, value });
        const inserted = table === replenTasks
          ? { id: 121, ...value }
          : table === cycleCounts
            ? { id: 333, ...value }
            : { id: 444, ...value };
        if (table === replenTasks) state.insertedReplenTask = inserted;
        return {
          returning: vi.fn(async () => [inserted]),
          then: (resolve: (value: any) => void) => Promise.resolve([inserted]).then(resolve),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: any) => {
        updates.push({ table, value });
        return { where: vi.fn(async () => []) };
      }),
    })),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };

  return { db, inserts, updates, state };
}

describe("ReplenishmentUseCases source-empty blockers", () => {
  it("creates a linked cycle count for picker-reported source-empty replen blockers", async () => {
    const { db, inserts, updates } = makeDb();
    const service = new ReplenishmentUseCases(db as any, {} as any);

    const task = await service.recordSourceEmptyBlocker({
      pickVariantId: 100,
      pickLocationId: 1,
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      sku: "SKU-1",
      sourceLocationCode: "B-01",
      userId: "picker-1",
    });

    expect(task).toMatchObject({
      id: 121,
      status: "blocked",
      blocksShipment: true,
      exceptionReason: "source_empty",
      linkedCycleCountId: 333,
    });

    expect(inserts.find(insert => insert.table === cycleCounts)?.value).toMatchObject({
      name: "Replen Source Empty - Task #121",
      status: "in_progress",
      warehouseId: 7,
      totalBins: 1,
      createdBy: "picker-1",
    });
    expect(inserts.find(insert => insert.table === cycleCountItems)?.value).toMatchObject({
      cycleCountId: 333,
      warehouseLocationId: 2,
      productVariantId: 100,
      productId: 10,
      expectedSku: "SKU-1",
      expectedQty: 5,
      countedSku: "SKU-1",
      countedQty: 0,
      status: "pending",
      countedBy: "picker-1",
    });
    expect(updates.find(update => update.table === replenTasks)?.value).toMatchObject({
      linkedCycleCountId: 333,
    });
  });

  it("executes picker-confirmed replen when guidance is inline", async () => {
    const { db, inserts, state } = makeDb();
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceLocationCode: "B-01",
      sourceVariantId: null,
      sourceVariantSku: "SKU-1",
      sourceVariantName: "Each",
      pickVariantId: 100,
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      replenMethod: "full_case",
      executionMode: "inline",
      taskNotes: "Below threshold",
      triggerValue: 2,
      autoReplen: 1,
      evaluatedQty: 1,
    });
    const executeTask = vi.spyOn(service, "executeTask").mockImplementation(async () => {
      state.insertedReplenTask = {
        ...state.insertedReplenTask,
        status: "completed",
        qtyCompleted: 4,
      };
      return { moved: 4 };
    });

    const result = await service.createAndExecuteReplen(100, 1, "picker-1");

    expect(executeTask).toHaveBeenCalledWith(121, "picker-1");
    expect(result).toMatchObject({
      moved: 4,
      task: {
        id: 121,
        status: "completed",
        qtyCompleted: 4,
      },
    });
    expect(inserts.find(insert => insert.table === replenTasks)?.value).toMatchObject({
      status: "pending",
      executionMode: "inline",
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
    });
  });

  it("returns an existing queued replen task instead of creating a duplicate", async () => {
    const { db, inserts, state } = makeDb();
    state.insertedReplenTask = {
      id: 222,
      fromLocationId: 2,
      toLocationId: 1,
      pickProductVariantId: 100,
      sourceProductVariantId: 100,
      status: "pending",
      executionMode: "queue",
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      qtyCompleted: 0,
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const guidanceSpy = vi.spyOn(service, "checkReplenNeeded");
    const executeSpy = vi.spyOn(service, "executeTask");

    const result = await service.createAndExecuteReplen(100, 1, "picker-1");

    expect(result).toMatchObject({
      moved: 0,
      task: {
        id: 222,
        status: "pending",
        executionMode: "queue",
      },
    });
    expect(inserts.filter(insert => insert.table === replenTasks)).toHaveLength(0);
    expect(guidanceSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("executes an existing inline replen task instead of creating a duplicate", async () => {
    const { db, inserts, state } = makeDb();
    state.insertedReplenTask = {
      id: 223,
      fromLocationId: 2,
      toLocationId: 1,
      pickProductVariantId: 100,
      sourceProductVariantId: 100,
      status: "pending",
      executionMode: "inline",
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      qtyCompleted: 0,
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const guidanceSpy = vi.spyOn(service, "checkReplenNeeded");
    const executeTask = vi.spyOn(service, "executeTask").mockImplementation(async () => {
      state.insertedReplenTask = {
        ...state.insertedReplenTask,
        status: "completed",
        qtyCompleted: 4,
      };
      return { moved: 4 };
    });

    const result = await service.createAndExecuteReplen(100, 1, "picker-1");

    expect(executeTask).toHaveBeenCalledWith(223, "picker-1");
    expect(result).toMatchObject({
      moved: 4,
      task: {
        id: 223,
        status: "completed",
        qtyCompleted: 4,
      },
    });
    expect(inserts.filter(insert => insert.table === replenTasks)).toHaveLength(0);
    expect(guidanceSpy).not.toHaveBeenCalled();
  });

  it("predicts replenishment from the post-pick bin quantity", async () => {
    const pickRows = [[{ variantQty: 5 }], [{ variantQty: 9 }]];
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: vi.fn(async () => table === inventoryLevels ? pickRows.shift() ?? [] : []),
          }),
        }),
      })),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceLocationCode: "B-01",
      sourceVariantId: null,
      sourceVariantSku: "SKU-1",
      sourceVariantName: "Each",
      pickVariantId: 100,
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      replenMethod: "full_case",
      executionMode: "inline",
      taskNotes: "Below threshold",
      triggerValue: 3,
      autoReplen: 1,
      evaluatedQty: 2,
    });

    const prediction = await service.predictReplenAfterPick(100, 1, 3);

    expect(service.checkReplenNeeded).toHaveBeenCalledWith(100, 1, {
      currentQtyOverride: 2,
    });
    expect(prediction).toMatchObject({
      systemQty: 5,
      postPickQty: 2,
      triggerValue: 3,
      replenNeeded: true,
      sourceLocationCode: "B-01",
      sourceQty: 9,
    });
  });
});
