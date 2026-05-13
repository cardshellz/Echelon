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
  productLocations,
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
  const pickLocation = { id: 1, code: "A-01", warehouseId: 7, parentLocationId: null, isPickable: 1 };
  const sourceLocation = { id: 2, code: "B-01", warehouseId: 7, parentLocationId: null, isPickable: 0 };
  const sourceLevel = { id: 22, warehouseLocationId: 2, productVariantId: 100, variantQty: 5 };
  const tierDefault = {
    id: 1,
    hierarchyLevel: 1,
    warehouseId: null,
    triggerValue: 10,
    maxQty: 20,
    replenMethod: "full_case",
    priority: 5,
    sourceLocationType: "reserve",
    sourceHierarchyLevel: 1,
    sourcePriority: "fifo",
    autoReplen: 0,
    isActive: 1,
  };

  const selectRows = (table: unknown) => {
    const count = selectCounts.get(table) ?? 0;
    selectCounts.set(table, count + 1);
    if (table === replenTasks) return state.insertedReplenTask ? [state.insertedReplenTask] : [];
    if (table === productVariants) return [pickVariant];
    if (table === warehouseLocations) return count === 0 ? [pickLocation] : [sourceLocation];
    if (table === productLocations) return [{ id: 55 }];
    if (table === locationReplenConfig) return [];
    if (table === replenRules) return [];
    if (table === replenTierDefaults) return [tierDefault];
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

  return { db, inserts, updates, state, selectCounts };
}

function makeSourceResolutionDb(options?: { explicitSourceRule?: boolean; noSourceVariants?: boolean; activeTask?: any }) {
  const inserts: Array<{ table: unknown; value: any }> = [];
  const pickVariant = {
    id: 66,
    sku: "ARM-ENV-SGL-P50",
    name: "Pack of 50",
    productId: 33,
    hierarchyLevel: 1,
    unitsPerVariant: 50,
    parentVariantId: null,
    isActive: true,
  };
  const c700 = {
    id: 67,
    sku: "ARM-ENV-SGL-C700",
    name: "Case of 700",
    productId: 33,
    hierarchyLevel: 3,
    unitsPerVariant: 700,
    parentVariantId: null,
    position: 2,
    isActive: true,
  };
  const c750 = {
    id: 438,
    sku: "ARM-ENV-SGL-C750",
    name: "Case of 750",
    productId: 33,
    hierarchyLevel: 3,
    unitsPerVariant: 750,
    parentVariantId: null,
    position: 0,
    isActive: true,
  };
  const pickLocation = { id: 1, code: "RACK-03-A", warehouseId: 7, parentLocationId: null, isPickable: 1 };
  const sourceLocation = { id: 2, code: "F-02", warehouseId: 7, parentLocationId: null, isPickable: 1, locationType: "pick", isActive: 1, cycleCountFreezeId: null };
  const tierDefault = {
    id: 1,
    hierarchyLevel: 1,
    warehouseId: null,
    triggerValue: 0,
    maxQty: null,
    replenMethod: "case_break",
    priority: 5,
    sourceLocationType: "pick",
    sourceHierarchyLevel: 3,
    sourcePriority: "fifo",
    autoReplen: 0,
    isActive: 1,
  };
  const explicitRule = {
    id: 10,
    pickProductVariantId: 66,
    productId: 33,
    sourceProductVariantId: 438,
    sourceLocationType: "pick",
    sourcePriority: "fifo",
    triggerValue: 0,
    replenMethod: "case_break",
    priority: 1,
    autoReplen: 0,
    isActive: 1,
  };
  const productVariantRows = options?.explicitSourceRule
    ? [[pickVariant], [c750], [c750]]
    : options?.noSourceVariants
      ? [[pickVariant], [pickVariant], [pickVariant]]
      : [[pickVariant], [pickVariant, c750, c700], [c700]];
  const tableCounts = new Map<unknown, number>();

  const selectRows = (table: unknown) => {
    const count = tableCounts.get(table) ?? 0;
    tableCounts.set(table, count + 1);
    if (table === inventoryLevels) return [{ id: 1, warehouseLocationId: 1, productVariantId: 66, variantQty: 0 }];
    if (table === warehouseLocations) return [pickLocation];
    if (table === productLocations) return [{ id: 405 }];
    if (table === productVariants) return productVariantRows.shift() ?? [];
    if (table === locationReplenConfig) return [];
    if (table === replenRules) return options?.explicitSourceRule ? [explicitRule] : [];
    if (table === replenTierDefaults) return [tierDefault];
    if (table === replenTasks) return options?.activeTask ? [options.activeTask] : [];
    return [];
  };

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(() => {
          const rows = selectRows(table);
          return {
            limit: vi.fn(async () => rows),
            then: (resolve: (value: any[]) => void, reject: (reason?: unknown) => void) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: any) => {
        inserts.push({ table, value });
        return {
          returning: vi.fn(async () => [{ id: 501, ...value }]),
        };
      }),
    })),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };

  return { db, sourceLocation, inserts };
}

describe("ReplenishmentUseCases source-empty blockers", () => {
  it("selects a stocked source variant instead of an unstocked active sibling from tier defaults", async () => {
    const { db, sourceLocation } = makeSourceResolutionDb();
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const findSourceLocation = vi.spyOn(service as any, "findSourceLocation")
      .mockImplementation(async (variantId: number) => variantId === 67 ? sourceLocation : null);
    vi.spyOn(service as any, "getSourceSlotRank").mockResolvedValue(0);

    const guidance = await service.checkReplenNeeded(66, 1, {
      currentQtyOverride: 0,
    });

    expect(findSourceLocation).toHaveBeenCalledWith(67, 7, "pick", null, "fifo");
    expect(findSourceLocation).toHaveBeenCalledWith(438, 7, "pick", null, "fifo");
    expect(guidance).toMatchObject({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceLocationCode: "F-02",
      sourceVariantId: 67,
      sourceVariantSku: "ARM-ENV-SGL-C700",
      replenMethod: "case_break",
    });
  });

  it("honors an explicit source rule and reports stockout instead of falling back silently", async () => {
    const { db, sourceLocation } = makeSourceResolutionDb({ explicitSourceRule: true });
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const findSourceLocation = vi.spyOn(service as any, "findSourceLocation")
      .mockImplementation(async (variantId: number) => variantId === 67 ? sourceLocation : null);

    const guidance = await service.checkReplenNeeded(66, 1, {
      currentQtyOverride: 0,
    });

    expect(findSourceLocation).toHaveBeenCalledTimes(1);
    expect(findSourceLocation).toHaveBeenCalledWith(438, 7, "pick", null, "fifo");
    expect(guidance).toMatchObject({
      needed: true,
      stockout: true,
      sourceLocationId: null,
      sourceVariantId: null,
      skipReason: "no_source_stock",
    });
    expect(guidance.taskNotes).toContain("Configured source variant ARM-ENV-SGL-C750 has no stock in pick locations");
  });

  it("falls back to same-variant source stock when no higher source UOM exists", async () => {
    const { db, sourceLocation } = makeSourceResolutionDb({ noSourceVariants: true });
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service as any, "findSourceLocation")
      .mockImplementation(async (variantId: number) => variantId === 66 ? sourceLocation : null);

    const guidance = await service.checkReplenNeeded(66, 1, {
      currentQtyOverride: 0,
    });

    expect(guidance).toMatchObject({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceVariantId: 66,
      sourceVariantSku: "ARM-ENV-SGL-P50",
    });
    expect(guidance.taskNotes).toContain("Auto-triggered");
  });

  it("can ignore a stale active task while auditing blocked task recovery", async () => {
    const staleTask = {
      id: 765,
      status: "blocked",
      blocksShipment: false,
      sourceProductVariantId: 438,
      pickProductVariantId: 66,
      toLocationId: 1,
      fromLocationId: 1,
      qtySourceUnits: 0,
      qtyTargetUnits: 0,
      replenMethod: "case_break",
      executionMode: "queue",
      exceptionReason: "no_source_stock",
      notes: "Blocked: no source stock found in pick locations",
    };
    const { db, sourceLocation } = makeSourceResolutionDb({ activeTask: staleTask });
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service as any, "findSourceLocation")
      .mockImplementation(async (variantId: number) => variantId === 67 ? sourceLocation : null);
    vi.spyOn(service as any, "getSourceSlotRank").mockResolvedValue(0);

    const guidance = await service.checkReplenNeeded(66, 1, {
      currentQtyOverride: 0,
      ignoreTaskId: 765,
    });

    expect(guidance).toMatchObject({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceVariantId: 67,
      sourceVariantSku: "ARM-ENV-SGL-C700",
    });
  });

  it("does not create fake no-source replen tasks for non-shipment event checks", async () => {
    const { db } = makeSourceResolutionDb({ explicitSourceRule: true });
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service as any, "findSourceLocation").mockResolvedValue(null);
    vi.spyOn(service as any, "tryCascadeReplen").mockResolvedValue(null);

    const task = await service.checkAndTriggerAfterPick(66, 1, "event_driven");

    expect(task).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("keeps shipment-blocking no-source checks as blocked review tasks", async () => {
    const { db, inserts } = makeSourceResolutionDb({ explicitSourceRule: true });
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service as any, "findSourceLocation").mockResolvedValue(null);
    vi.spyOn(service as any, "tryCascadeReplen").mockResolvedValue(null);

    const task = await service.checkAndTriggerAfterPick(66, 1, "inline_pick", {
      orderId: 10,
      orderItemId: 20,
      orderNumber: "#10",
      blocksShipment: true,
    });

    expect(task).toMatchObject({
      id: 501,
      status: "blocked",
      blocksShipment: true,
      qtySourceUnits: 0,
      qtyTargetUnits: 0,
      exceptionReason: "no_source_stock",
    });
    expect(inserts.find(insert => insert.table === replenTasks)?.value).toMatchObject({
      fromLocationId: 1,
      toLocationId: 1,
      blocksShipment: true,
    });
  });

  it("rejects manually marking no-source review tasks done", async () => {
    const reviewTask = {
      id: 977,
      status: "blocked",
      blocksShipment: false,
      qtySourceUnits: 0,
      qtyTargetUnits: 0,
      exceptionReason: "no_source_stock",
      dependsOnTaskId: null,
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn(async () => [reviewTask]),
          }),
        }),
      })),
      update: vi.fn(),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);

    await expect(service.markTaskDone(977, "admin")).rejects.toThrow("no valid source stock");
    expect(db.update).not.toHaveBeenCalled();
  });

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
      productId: 10,
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

  it("surfaces existing active replen task details in guidance", async () => {
    const { db, state } = makeDb();
    state.insertedReplenTask = {
      id: 224,
      fromLocationId: 2,
      toLocationId: 1,
      pickProductVariantId: 100,
      sourceProductVariantId: 100,
      status: "pending",
      executionMode: "queue",
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      qtyCompleted: 0,
      replenMethod: "full_case",
      autoReplen: 0,
      blocksShipment: false,
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);

    const guidance = await service.checkReplenNeeded(100, 1, {
      currentQtyOverride: 20,
    });

    expect(guidance).toMatchObject({
      needed: true,
      stockout: false,
      existingTaskId: 224,
      existingTaskStatus: "pending",
      existingTaskExecutionMode: "queue",
      existingTaskBlocksShipment: false,
      sourceLocationId: 2,
      sourceLocationCode: "B-01",
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      replenMethod: "full_case",
      triggerValue: 10,
      evaluatedQty: 20,
    });
  });

  it("routes short-pick replen guidance through shared replen guidance", async () => {
    const { db } = makeDb();
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const guidanceSpy = vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceLocationCode: "B-01",
      sourceVariantId: 100,
      sourceVariantSku: "SKU-1",
      sourceVariantName: "Each",
      pickVariantId: 100,
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      replenMethod: "full_case",
      executionMode: "queue",
      taskNotes: "Below threshold",
      triggerValue: 10,
      autoReplen: 0,
      evaluatedQty: 0,
    });

    const guidance = await service.getReplenGuidance("SKU-1", "A-01");

    expect(guidanceSpy).toHaveBeenCalledWith(100, 1, {
      currentQtyOverride: 0,
    });
    expect(guidance).toEqual({ action: "short_pick_with_replen" });
  });

  it("queues reserve replen from a confirmed short pick without inline execution", async () => {
    const { db, inserts, selectCounts } = makeDb();
    selectCounts.set(warehouseLocations, 1);
    const service = new ReplenishmentUseCases(db as any, {} as any);
    vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
      needed: true,
      stockout: false,
      sourceLocationId: 2,
      sourceLocationCode: "B-01",
      sourceVariantId: 100,
      sourceVariantSku: "SKU-1",
      sourceVariantName: "Each",
      pickVariantId: 100,
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      replenMethod: "full_case",
      executionMode: "queue",
      taskNotes: "Below threshold",
      triggerValue: 10,
      autoReplen: 0,
      evaluatedQty: 0,
    });
    const executeSpy = vi.spyOn(service, "executeTask");

    const result = await service.ensureQueuedReplenForShortPick(100, 1, "picker-1", {
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      blocksShipment: false,
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      moved: 0,
      task: {
        id: 121,
        status: "pending",
        executionMode: "queue",
        triggeredBy: "short_pick",
        blocksShipment: false,
      },
    });
    expect(inserts.find(insert => insert.table === replenTasks)?.value).toMatchObject({
      fromLocationId: 2,
      toLocationId: 1,
      productId: 10,
      pickProductVariantId: 100,
      sourceProductVariantId: 100,
      qtySourceUnits: 4,
      qtyTargetUnits: 4,
      status: "pending",
      triggeredBy: "short_pick",
      executionMode: "queue",
      orderId: 900,
      orderItemId: 500,
      blocksShipment: false,
      createdBy: "picker-1",
    });
    expect(inserts.find(insert => insert.table === replenTasks)?.value.notes).toContain("Queued from confirmed short pick");
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

  it("backfills and rechecks historical blocked tasks without product_id", async () => {
    const updates: Array<{ table: unknown; value: any }> = [];
    const blockedTask = {
      id: 765,
      productId: null,
      fromLocationId: 1,
      toLocationId: 1,
      pickProductVariantId: 100,
      sourceProductVariantId: 101,
      status: "blocked",
      blocksShipment: false,
      dependsOnTaskId: null,
      exceptionReason: null,
      notes: "Blocked: no source stock found in pick locations",
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: vi.fn(() => {
            const rows = table === productVariants
              ? [{ id: 100 }, { id: 101 }]
              : table === productLocations
                ? [{ warehouseLocationId: 1 }]
                : table === inventoryLevels
                  ? [{ id: 22 }]
                  : [blockedTask];
            return {
              limit: vi.fn(async () => rows),
              then: (resolve: (value: any[]) => void, reject: (reason?: unknown) => void) =>
                Promise.resolve(rows).then(resolve, reject),
            };
          }),
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((value: any) => {
          updates.push({ table, value });
          return { where: vi.fn(async () => []) };
        }),
      })),
      execute: vi.fn(async () => ({ rows: [{ is_pickable: 1, location_type: "pick" }] })),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const checkSpy = vi.spyOn(service, "checkReplenForLocation").mockResolvedValue(undefined);

    await service.reevaluateReplenForProduct(10);

    expect(updates[0]).toMatchObject({
      table: replenTasks,
      value: { productId: 10 },
    });
    expect(updates[1]).toMatchObject({
      table: replenTasks,
      value: {
        status: "cancelled",
        exceptionReason: "no_source_stock",
      },
    });
    expect(checkSpy).toHaveBeenCalledWith(1);
  });

  it("does not auto-cancel shipment-blocking replen exceptions during product recheck", async () => {
    const updates: Array<{ table: unknown; value: any }> = [];
    const blockedTask = {
      id: 121,
      productId: null,
      fromLocationId: 2,
      toLocationId: 1,
      pickProductVariantId: 100,
      sourceProductVariantId: 100,
      status: "blocked",
      blocksShipment: true,
      dependsOnTaskId: null,
      exceptionReason: "source_empty",
      notes: "Picker reported source empty",
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: vi.fn(() => {
            const rows = table === productVariants
              ? [{ id: 100 }]
              : table === productLocations
                ? [{ warehouseLocationId: 1 }]
                : [blockedTask];
            return {
              limit: vi.fn(async () => rows),
              then: (resolve: (value: any[]) => void, reject: (reason?: unknown) => void) =>
                Promise.resolve(rows).then(resolve, reject),
            };
          }),
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((value: any) => {
          updates.push({ table, value });
          return { where: vi.fn(async () => []) };
        }),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    const checkSpy = vi.spyOn(service, "checkReplenForLocation").mockResolvedValue(undefined);

    await service.reevaluateReplenForProduct(10);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: replenTasks,
      value: { productId: 10 },
    });
    expect(checkSpy).toHaveBeenCalledWith(1);
  });
});
