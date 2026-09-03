import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function cycleCountItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 81,
    cycleCountId: 8,
    warehouseLocationId: 2,
    productVariantId: 101,
    productId: 10,
    expectedSku: "EA",
    expectedQty: 10,
    countedSku: "EA",
    countedQty: 6,
    varianceQty: -4,
    varianceType: "quantity_under",
    varianceReason: null,
    varianceNotes: null,
    status: "variance",
    relatedItemId: null,
    mismatchType: null,
    requiresApproval: 1,
    approvedBy: null,
    approvedAt: null,
    adjustmentTransactionId: null,
    resolvedBy: null,
    resolvedAt: null,
    countedBy: "counter",
    countedAt: new Date("2026-09-03T10:00:00.000Z"),
    createdAt: new Date("2026-09-03T09:00:00.000Z"),
    ...overrides,
  };
}

function subject(options: {
  item?: ReturnType<typeof cycleCountItem>;
  linkedItem?: ReturnType<typeof cycleCountItem>;
  reconcile?: ReturnType<typeof vi.fn>;
  autoApproveTolerance?: string;
  cycleCountStatus?: string;
} = {}) {
  const item = options.item ?? cycleCountItem();
  const inventoryUseCases = {
    adjustInventory: vi.fn(),
    transfer: vi.fn(),
  };
  const channelSync = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
  const replenishment = { checkReplenForLocation: vi.fn(async () => undefined) };
  const storage = {
    getCycleCountById: vi.fn(async () => ({ id: 8, status: options.cycleCountStatus ?? "in_progress" })),
    getCycleCountItemById: vi.fn(async (id: number) => {
      if (id === item.id) return item;
      if (id === options.linkedItem?.id) return options.linkedItem;
      return undefined;
    }),
    getCycleCountItems: vi.fn(async () => [item]),
    updateCycleCountItem: vi.fn(async () => item),
    updateCycleCount: vi.fn(async () => undefined),
    getWarehouseLocationById: vi.fn(async () => ({ id: 2, code: "P-2", isPickable: 1 })),
    getSetting: vi.fn(async (key: string) => key === "cycle_count_auto_approve_tolerance"
      ? (options.autoApproveTolerance ?? "0")
      : "10"),
    getProductVariantBySku: vi.fn(async () => ({ id: 101, productId: 10, sku: "EA" })),
  };
  const reconcile = options.reconcile ?? vi.fn(async () => ({
    outcome: "cycle_count_reconciled",
    cycleCountId: 8,
    cycleCountItemId: 81,
    productVariantId: 101,
    warehouseLocationId: 2,
    quantityBefore: 10,
    quantityAfter: 6,
    quantityDelta: -4,
    adjustmentTransactionId: 901,
    displacedOrderIds: [70],
    idempotentReplay: false,
  }));
  const reservation = { reconcileCycleCountInventory: reconcile };
  const db = { execute: vi.fn(async () => ({ rows: [] })) };
  const service = new CycleCountUseCases(
    db as any,
    inventoryUseCases as any,
    channelSync as any,
    replenishment as any,
    storage as any,
    reservation as any,
  );
  return { service, item, db, inventoryUseCases, channelSync, replenishment, storage, reconcile };
}

describe("CycleCountUseCases authority reconciliation", () => {
  it("routes manual variance approval through the inventory authority boundary", async () => {
    const fixture = subject();

    await expect(fixture.service.approveVariance(8, 81, {
      reasonCode: "shrinkage",
      notes: "verified recount",
      approvedBy: "user:7",
    })).resolves.toEqual({
      success: true,
      adjustmentsMade: [{
        sku: "EA",
        type: "quantity_under",
        qtyChange: -4,
        locationId: 2,
      }],
      linkedItemsApproved: 0,
    });

    expect(fixture.reconcile).toHaveBeenCalledWith({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "shrinkage",
      actor: "user:7",
      reason: "Cycle count adjustment (real-time): EA. Counted=6. verified recount",
    });
    expect(fixture.inventoryUseCases.adjustInventory).not.toHaveBeenCalled();
    expect(fixture.channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(101);
    expect(fixture.replenishment.checkReplenForLocation).toHaveBeenCalledWith(2);
  });

  it("persists an auto-approval observation before invoking the same authority boundary", async () => {
    const item = cycleCountItem({ countedQty: null, varianceQty: null, varianceType: null, status: "pending" });
    const reconcile = vi.fn(async () => ({
      outcome: "cycle_count_reconciled",
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      quantityAfter: 9,
      quantityDelta: -1,
      adjustmentTransactionId: 902,
      displacedOrderIds: [],
      idempotentReplay: false,
    }));
    const fixture = subject({ item, reconcile, autoApproveTolerance: "2" });

    await expect(fixture.service.recordCount(8, 81, {
      countedSku: "EA",
      countedQty: 9,
      notes: "within tolerance",
    }, "counter:3")).resolves.toMatchObject({
      success: true,
      varianceType: "quantity_under",
      varianceQty: -1,
    });

    expect(fixture.storage.updateCycleCountItem.mock.calls[0]).toEqual([81, expect.objectContaining({
      countedQty: 9,
      varianceQty: -1,
      status: "variance",
      requiresApproval: 0,
    })]);
    expect(fixture.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      cycleCountItemId: 81,
      countedQty: 9,
      reasonCode: "within_tolerance",
      actor: "counter:3",
    }));
    expect(fixture.inventoryUseCases.adjustInventory).not.toHaveBeenCalled();
  });

  it("leaves a failed auto-approval as a reviewable variance without direct inventory fallback", async () => {
    const item = cycleCountItem({ countedQty: null, varianceQty: null, varianceType: null, status: "pending" });
    const reconcile = vi.fn(async () => {
      throw Object.assign(new Error("canonical ownership mismatch"), { code: "CYCLE_COUNT_CLAIM_OWNERSHIP_MISMATCH" });
    });
    const fixture = subject({ item, reconcile, autoApproveTolerance: "2" });

    await expect(fixture.service.recordCount(8, 81, {
      countedSku: "EA",
      countedQty: 9,
    }, "counter:3")).rejects.toThrow("canonical ownership mismatch");

    expect(fixture.storage.updateCycleCountItem).toHaveBeenCalledTimes(1);
    expect(fixture.storage.updateCycleCountItem).toHaveBeenCalledWith(81, expect.objectContaining({
      status: "variance",
    }));
    expect(fixture.inventoryUseCases.adjustInventory).not.toHaveBeenCalled();
    expect(fixture.channelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
  });

  it("rejects recording against an item owned by a different cycle count", async () => {
    const fixture = subject({ item: cycleCountItem({ cycleCountId: 9, status: "pending" }) });

    await expect(fixture.service.recordCount(8, 81, {
      countedSku: "EA",
      countedQty: 6,
    }, "counter:3")).rejects.toMatchObject({
      statusCode: 409,
      message: "Item does not belong to this cycle count",
    });

    expect(fixture.storage.updateCycleCountItem).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it.each(["approved", "adjusted", "resolved"])(
    "rejects recording over a terminal %s item",
    async (status) => {
      const fixture = subject({ item: cycleCountItem({ status }) });

      await expect(fixture.service.recordCount(8, 81, {
        countedSku: "EA",
        countedQty: 6,
      }, "counter:3")).rejects.toMatchObject({
        statusCode: 409,
        message: `Cannot record a count for a ${status} item`,
      });

      expect(fixture.storage.updateCycleCountItem).not.toHaveBeenCalled();
      expect(fixture.reconcile).not.toHaveBeenCalled();
    },
  );

  it("rejects recording against a cycle count that is no longer in progress", async () => {
    const fixture = subject({
      item: cycleCountItem({ status: "pending" }),
      cycleCountStatus: "completed",
    });

    await expect(fixture.service.recordCount(8, 81, {
      countedSku: "EA",
      countedQty: 6,
    }, "counter:3")).rejects.toMatchObject({
      statusCode: 409,
      message: "Cannot record a count for a completed cycle count",
    });

    expect(fixture.storage.updateCycleCountItem).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it("rejects approving an item owned by a different cycle count", async () => {
    const fixture = subject({ item: cycleCountItem({ cycleCountId: 9 }) });

    await expect(fixture.service.approveVariance(8, 81, {
      reasonCode: "shrinkage",
      approvedBy: "user:7",
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "Item does not belong to this cycle count",
    });

    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it("dispatches primary effects before a linked reconciliation fails", async () => {
    const item = cycleCountItem({ relatedItemId: 82 });
    const linkedItem = cycleCountItem({
      id: 82,
      expectedSku: "P5",
      countedSku: "P5",
      productVariantId: 102,
      relatedItemId: 81,
    });
    const primaryResult = {
      outcome: "cycle_count_reconciled" as const,
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      quantityAfter: 6,
      quantityDelta: -4,
      adjustmentTransactionId: 901,
      displacedOrderIds: [],
      idempotentReplay: false,
    };
    const reconcile = vi.fn()
      .mockResolvedValueOnce(primaryResult)
      .mockRejectedValueOnce(new Error("linked reconciliation failed"));
    const fixture = subject({ item, linkedItem, reconcile });

    await expect(fixture.service.approveVariance(8, 81, {
      reasonCode: "shrinkage",
      approvedBy: "user:7",
    })).rejects.toThrow("linked reconciliation failed");

    expect(fixture.channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledTimes(1);
    expect(fixture.channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(101);
    expect(fixture.replenishment.checkReplenForLocation).toHaveBeenCalledTimes(1);
    expect(fixture.replenishment.checkReplenForLocation).toHaveBeenCalledWith(2);
  });

  it("does not execute raw inventory transfers during bulk approval", async () => {
    const fixture = subject();

    await expect(fixture.service.bulkApprove(8, {
      itemIds: [81],
      reasonCode: "shrinkage",
      approvedBy: "user:7",
    })).resolves.toMatchObject({ transfersMade: 0 });

    expect(fixture.inventoryUseCases.transfer).not.toHaveBeenCalled();
  });
});
