import { describe, it, expect, vi } from "vitest";
import { ReceivingService } from "../../../../modules/procurement/receiving.service";

describe("ReceivingService - completeAllLines semantics", () => {
  it("should preserve existing partial entries and backfill untouched lines with expectedQty", async () => {
    // Mock the storage layer
    const mockStorage = {
      getReceivingLines: vi.fn().mockResolvedValue([
        { id: 1, expectedQty: 10, receivedQty: 5, status: "pending" }, // Partially received manually
        { id: 2, expectedQty: 20, receivedQty: 0, status: "pending" }, // Untouched (0)
        { id: 3, expectedQty: 30, receivedQty: null, status: "pending" }, // Untouched (null)
        { id: 4, expectedQty: 40, receivedQty: 40, status: "complete" }, // Already complete
      ]),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({}),
      getReceivingOrderById: vi.fn().mockResolvedValue({ id: 1, vendorId: null }),
    };

    const service = new ReceivingService({} as any, {} as any, {} as any, mockStorage as any);

    const result = await service.completeAllLines(1);

    // Assert that we correctly skip the completed line
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledTimes(3);

    // Line 1: Was partially received (5). Should retain its manual 5, NOT go to expected 10.
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(1, {
      receivedQty: 5,
      status: "complete",
    });

    // Line 2: Untouched (0). Should backfill to expected (20).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(2, {
      receivedQty: 20,
      status: "complete",
    });

    // Line 3: Untouched (null). Should backfill to expected (30).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(3, {
      receivedQty: 30,
      status: "complete",
    });

    expect(result.updated).toBe(3);
  });
});

describe("ReceivingService - close reconciliation semantics", () => {
  it("retries PO reconciliation for an already closed receipt without reposting inventory", async () => {
    const lines = [
      {
        id: 501,
        purchaseOrderLineId: 100,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 500,
        putawayLocationId: 12,
      },
    ];
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue({
        id: 9,
        status: "closed",
        purchaseOrderId: 1,
        receivedLineCount: 1,
        receivedTotalUnits: 3,
      }),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
    };
    const inventoryCore = { receiveInventory: vi.fn() };
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue({
        purchaseOrderId: 1,
        appliedLines: 1,
        existingReceiptLines: 0,
        skippedLines: 0,
        autoMatchedLines: 0,
        issues: [],
      }),
    };
    const service = new ReceivingService(
      {} as any,
      inventoryCore as any,
      {} as any,
      mockStorage as any,
      purchasing as any,
    );

    const result = await service.close(9, "user-1");

    expect(inventoryCore.receiveInventory).not.toHaveBeenCalled();
    expect(purchasing.onReceivingOrderClosed).toHaveBeenCalledWith(9, [
      {
        receivingLineId: 501,
        purchaseOrderLineId: 100,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 500,
      },
    ]);
    expect(result).toMatchObject({
      success: true,
      linesProcessed: 1,
      unitsReceived: 3,
      putawayLocationIds: [12],
    });
  });

  it("surfaces PO reconciliation failures after inventory posting", async () => {
    const order = {
      id: 10,
      status: "open",
      sourceType: "po",
      poNumber: "PO-10",
      purchaseOrderId: 1,
    };
    const lines = [
      {
        id: 601,
        productVariantId: 5,
        purchaseOrderLineId: 100,
        receivedQty: 2,
        damagedQty: 0,
        unitCost: 500,
        putawayLocationId: 12,
      },
    ];
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
      getProductVariantById: vi.fn().mockResolvedValue({ id: 5, hierarchyLevel: 1 }),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([]),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "closed",
        receivedLineCount: 1,
        receivedTotalUnits: 2,
      }),
    };
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
    };
    const inventoryCore = { receiveInventory: vi.fn().mockResolvedValue(undefined) };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined) };
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockRejectedValue(new Error("PO reconcile failed")),
    };
    const reconciliationFailureReporter = vi.fn().mockResolvedValue(undefined);
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      channelSync as any,
      mockStorage as any,
      purchasing as any,
      null,
      reconciliationFailureReporter,
    );

    await expect(service.close(10, "user-1")).rejects.toThrow("PO reconcile failed");
    expect(inventoryCore.receiveInventory).toHaveBeenCalledOnce();
    expect(purchasing.onReceivingOrderClosed).toHaveBeenCalledOnce();
    expect(reconciliationFailureReporter).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderId: 1,
      receivingOrderId: 10,
      userId: "user-1",
      message: "PO reconcile failed",
    }));
  });
});
