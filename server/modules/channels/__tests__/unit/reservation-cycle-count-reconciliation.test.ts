import { describe, expect, it, vi } from "vitest";

import { createReservationService } from "../../reservation.service";

const OCCURRED_AT = new Date("2026-09-03T12:00:00.000Z");

describe("legacy cycle-count reconciliation", () => {
  it("commits adjustment and item approval before running registered effects", async () => {
    let committed = false;
    const postCommitEffect = vi.fn(async () => {
      expect(committed).toBe(true);
    });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "variance",
        adjustment_transaction_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, variant_qty: 10 }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      const result = await work({ execute });
      committed = true;
      return result;
    });
    const adjustInventory = vi.fn(async (params: any) => {
      params.deferUntilCommit(postCommitEffect);
      return { orphanedQty: 0, adjustmentTransactionId: 901 };
    });
    const approveCycleCountItemReconciliation = vi.fn(async () => undefined);
    const inventoryCore = {
      withTx: vi.fn(() => ({ adjustInventory, approveCycleCountItemReconciliation })),
    };
    const service = createReservationService(
      { transaction } as any,
      inventoryCore,
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical count",
    })).resolves.toEqual({
      outcome: "cycle_count_reconciled",
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
    });

    expect(adjustInventory).toHaveBeenCalledWith(expect.objectContaining({
      cycleCountId: 8,
      cycleCountItemId: 81,
      qtyDelta: -4,
      deferUntilCommit: expect.any(Function),
    }));
    expect(execute).toHaveBeenCalledTimes(3);
    expect(approveCycleCountItemReconciliation).toHaveBeenCalledWith({
      cycleCountItemId: 81,
      expectedStatus: "variance",
      actor: "user:7",
      reasonCode: "verified",
      adjustmentTransactionId: 901,
      occurredAt: OCCURRED_AT,
    });
    expect(postCommitEffect).toHaveBeenCalledOnce();
  });

  it("rolls back the legacy transaction when orphaned ownership cannot be reallocated", async () => {
    let committed = false;
    const postCommitEffect = vi.fn(async () => undefined);
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "variance",
        adjustment_transaction_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, variant_qty: 10 }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      const result = await work({ execute });
      committed = true;
      return result;
    });
    const adjustInventory = vi.fn(async (params: any) => {
      params.deferUntilCommit(postCommitEffect);
      return { orphanedQty: 2, adjustmentTransactionId: 901 };
    });
    const approveCycleCountItemReconciliation = vi.fn(async () => undefined);
    const inventoryCore = {
      withTx: vi.fn(() => ({ adjustInventory, approveCycleCountItemReconciliation })),
    };
    const service = createReservationService(
      { transaction } as any,
      inventoryCore,
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );
    vi.spyOn(service, "reallocateOrphaned").mockRejectedValueOnce(new Error("reallocation failed"));

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical count",
    })).rejects.toThrow("reallocation failed");

    expect(committed).toBe(false);
    expect(approveCycleCountItemReconciliation).not.toHaveBeenCalled();
    expect(postCommitEffect).not.toHaveBeenCalled();
  });

  it("replays historical cycle-count ledger lineage without another mutation", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "approved",
        adjustment_transaction_id: 901,
      }] })
      .mockResolvedValueOnce({ rows: [{
        variant_qty_before: 10,
        variant_qty_after: 6,
        variant_qty_delta: -4,
        product_variant_id: 101,
        from_location_id: 2,
        to_location_id: null,
        transaction_type: "adjustment",
        cycle_count_id: 8,
        reference_type: "cycle_count",
        reference_id: "8",
      }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => work({ execute }));
    const inventoryCore = { withTx: vi.fn() };
    const service = createReservationService(
      { transaction } as any,
      inventoryCore,
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );
    const reallocate = vi.spyOn(service, "reallocateOrphaned");

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "retry verified physical count",
    })).resolves.toEqual({
      outcome: "cycle_count_reconciled",
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      quantityAfter: 6,
      quantityDelta: -4,
      adjustmentTransactionId: 901,
      displacedOrderIds: [],
      idempotentReplay: true,
    });

    expect(inventoryCore.withTx).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  it("records durable no-op evidence before approving an unchanged count", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "counted",
        adjustment_transaction_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, variant_qty: 6 }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => work({ execute }));
    const adjustInventory = vi.fn();
    const recordCycleCountReconciliationNoop = vi.fn(async () => ({ adjustmentTransactionId: 903 }));
    const approveCycleCountItemReconciliation = vi.fn(async () => undefined);
    const inventoryCore = {
      withTx: vi.fn(() => ({
        adjustInventory,
        recordCycleCountReconciliationNoop,
        approveCycleCountItemReconciliation,
      })),
    };
    const service = createReservationService(
      { transaction } as any,
      inventoryCore,
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified unchanged count",
    })).resolves.toEqual(expect.objectContaining({
      quantityBefore: 6,
      quantityAfter: 6,
      quantityDelta: 0,
      adjustmentTransactionId: 903,
      idempotentReplay: false,
    }));

    expect(adjustInventory).not.toHaveBeenCalled();
    expect(recordCycleCountReconciliationNoop).toHaveBeenCalledWith({
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "verified unchanged count",
    });
    expect(approveCycleCountItemReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      adjustmentTransactionId: 903,
    }));
  });

  it("fails approved replay closed when historical lineage is missing", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "completed" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "approved",
        adjustment_transaction_id: null,
      }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => work({ execute }));
    const withTx = vi.fn();
    const service = createReservationService(
      { transaction } as any,
      { withTx },
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "retry historical count",
    })).rejects.toThrow("has no durable adjustment or no-op evidence");
    expect(withTx).not.toHaveBeenCalled();
  });

  it("rejects a new item reconciliation under a terminal parent count", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 8, status: "cancelled" }] })
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 2,
        product_variant_id: 101,
        counted_qty: 6,
        status: "variance",
        adjustment_transaction_id: null,
      }] });
    const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => work({ execute }));
    const withTx = vi.fn();
    const service = createReservationService(
      { transaction } as any,
      { withTx },
      { queueSyncAfterInventoryChange: vi.fn() },
      {} as any,
      undefined,
      () => OCCURRED_AT,
    );

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical count",
    })).rejects.toThrow("Cycle count 8 is not reconcilable from status cancelled");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(withTx).not.toHaveBeenCalled();
  });
});
