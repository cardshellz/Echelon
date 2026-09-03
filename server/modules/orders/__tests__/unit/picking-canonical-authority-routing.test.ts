import { describe, expect, it, vi } from "vitest";

import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../picking.use-cases";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    orderId: 900,
    sku: "P5",
    name: "Five pack",
    quantity: 1,
    pickedQuantity: 0,
    requiresShipping: 1,
    location: "A-01",
    status: "pending",
    shortReason: null,
    onHold: 0,
    ...overrides,
  } as any;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function executor(context: InventoryAvailabilityRuntimeClaimContext) {
  return {
    execute: vi.fn(async (work: (selected: InventoryAvailabilityRuntimeClaimContext) => Promise<unknown>) =>
      work(context)),
  };
}

function canonicalContext(canonical: Record<string, unknown>): InventoryAvailabilityRuntimeClaimContext {
  return {
    authority: "canonical",
    authorityRevision: "2",
    activationRunId: "8",
    legacy: {} as any,
    canonical: canonical as any,
    getLatestClaim: vi.fn(async () => ({
      claimId: "9",
      revision: 1,
      status: "active",
      plan: {} as any,
    })),
    getClaimOwningPickedLine: vi.fn(async () => ({
      claimId: "9",
      revision: 1,
      status: "active",
      plan: {} as any,
    })),
    getClaimLinePickMovementCursor: vi.fn(async () => "31"),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
}

describe("PickingUseCases canonical authority routing", () => {
  it("routes a completed pick through strict, recorded-stock, and observed canonical reconciliation", async () => {
    const beforeItem = item();
    const completedItem = item({ status: "completed", pickedQuantity: 1, pickedAt: new Date() });
    const canonical = {
      pickClaimLine: vi.fn()
        .mockRejectedValueOnce(codedError("CLAIM_PICK_LOCATION_SHORTFALL"))
        .mockRejectedValueOnce(codedError("CLAIM_LEVEL_CONFLICT"))
        .mockResolvedValueOnce({
          outcome: "picked_with_observation",
          warehouseLocationIds: [1],
          observedRelocatedQuantity: "1",
          recordedReconciledQuantity: "0",
          inventoryReviewId: 81,
        }),
      unpickClaimLine: vi.fn(),
    };
    const runtimeExecutor = executor(canonicalContext(canonical));
    const db = { transaction: vi.fn(), insert: vi.fn() };
    const inventoryCore = {
      pickItem: vi.fn(),
      unpickItem: vi.fn(),
      getLevel: vi.fn(async () => ({ variantQty: 4 })),
    };
    const replenishment = { createAndExecuteReplen: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(completedItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseId: 1,
        warehouseStatus: "ready",
        assignedPickerId: "picker-1",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => ({
        id: 105,
        sku: "P5",
        productId: 10,
        requiresShipping: true,
        trackInventory: true,
      })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{
        warehouseLocationId: 1,
        variantQty: 5,
      }]),
      getAllWarehouseLocations: vi.fn(async () => [{
        id: 1,
        code: "A-01",
        warehouseId: 1,
        isPickable: 1,
        isActive: 1,
        cycleCountFreezeId: null,
        locationType: "pick",
      }]),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
      getAllWarehouseSettings: vi.fn(async () => [{
        warehouseId: 1,
        postPickStatus: "completed",
        pickMode: "single_order",
        requireScanConfirm: 0,
      }]),
      updateOrderProgress: vi.fn(async () => ({ id: 900, warehouseStatus: "completed" })),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      replenishment as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
      deviceType: "scanner",
      sessionId: "session-1",
    })).resolves.toMatchObject({
      success: true,
      item: { id: 500, status: "completed", pickedQuantity: 1 },
      inventory: {
        deducted: true,
        locationId: 1,
        resolution: {
          autoResolved: true,
          code: "picker_scan_bin_shortage",
          reviewRequired: true,
        },
      },
    });

    expect(canonical.pickClaimLine.mock.calls.map(([command]) => command.locationStrategy)).toEqual([
      "strict",
      "reconcile_recorded_stock",
      "reconcile_picker_observation",
    ]);
    expect(canonical.pickClaimLine).toHaveBeenLastCalledWith(expect.objectContaining({
      claimId: "9",
      orderItemId: 500,
      warehouseLocationId: 1,
      quantity: "1",
      observation: expect.objectContaining({
        kind: "validated_item_scan",
        observedPhysicalQty: "1",
        locationCode: "A-01",
      }),
      wmsProgress: {
        expectedStatus: "pending",
        expectedPickedQuantity: 0,
        targetStatus: "completed",
        targetPickedQuantity: 1,
      },
      idempotencyKey: expect.stringMatching(/^inventory-picker-runtime:pick-reconcile_picker_observation:[a-f0-9]{64}$/),
    }));
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(replenishment.createAndExecuteReplen).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("fails closed when a physical WMS line has no active catalog variant", async () => {
    const beforeItem = item();
    const canonical = { pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() };
    const runtimeExecutor = executor(canonicalContext(canonical));
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseId: 1,
        warehouseStatus: "ready",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => null),
    };
    const service = new PickingUseCases(
      { transaction: vi.fn() } as any,
      {} as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({ reason: "canonical_picker_variant_missing" }),
    });

    expect(canonical.pickClaimLine).not.toHaveBeenCalled();
  });

  it("changes the canonical pick idempotency key after immutable pick lineage advances", async () => {
    const beforeItem = item();
    const completedItem = item({ status: "completed", pickedQuantity: 1, pickedAt: new Date() });
    const canonical = {
      pickClaimLine: vi.fn(async () => ({ outcome: "picked", warehouseLocationIds: [1] })),
      unpickClaimLine: vi.fn(),
    };
    const context = canonicalContext(canonical);
    context.getClaimLinePickMovementCursor = vi.fn()
      .mockResolvedValueOnce("31")
      .mockResolvedValueOnce("33");
    const storage = {
      getProductVariantBySku: vi.fn(async () => ({
        id: 105,
        sku: "P5",
        requiresShipping: true,
        trackInventory: true,
      })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{
        warehouseLocationId: 1,
        variantQty: 5,
      }]),
      getAllWarehouseLocations: vi.fn(async () => [{
        id: 1,
        code: "A-01",
        warehouseId: 1,
        isPickable: 1,
        isActive: 1,
        cycleCountFreezeId: null,
        locationType: "pick",
      }]),
      getOrderItemById: vi.fn(async () => completedItem),
    };
    const service = new PickingUseCases(
      {} as any,
      { getLevel: vi.fn(async () => ({ variantQty: 4 })) } as any,
      {} as any,
      storage as any,
    );
    const command = {
      itemId: 500,
      beforeItem,
      effectivePickedQuantity: 1,
      warehouseId: 1,
      userId: "picker-1",
      pickMethod: "scan",
    };

    await (service as any).completeCanonicalPick(context, command);
    await (service as any).completeCanonicalPick(context, command);

    const firstKey = canonical.pickClaimLine.mock.calls[0]?.[0]?.idempotencyKey;
    const secondKey = canonical.pickClaimLine.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstKey).toMatch(/^inventory-picker-runtime:pick-strict:[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^inventory-picker-runtime:pick-strict:[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
  });

  it("preserves the deployed full-quantity no-op inside the pinned legacy transaction", async () => {
    const beforeItem = item({ pickedQuantity: 1, status: "pending" });
    const legacyDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ warehouse_status: "ready", on_hold: 0 }] })
        .mockResolvedValueOnce({ rows: [{ status: "pending", picked_quantity: 1, quantity: 1 }] }),
    };
    const context = {
      ...canonicalContext({ pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() }),
      authority: "legacy" as const,
      activationRunId: null,
      legacyDb,
    };
    const runtimeExecutor = executor(context);
    const db = { transaction: vi.fn() };
    const inventoryCore = { withTx: vi.fn(), pickItem: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseId: 1,
        warehouseStatus: "ready",
        onHold: 0,
      })),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
    })).resolves.toMatchObject({ success: true, item: { status: "pending", pickedQuantity: 1 } });

    expect(runtimeExecutor.execute).toHaveBeenCalledOnce();
    expect(legacyDb.execute).toHaveBeenCalledTimes(2);
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the claim cannot fund a recorded-stock reconciliation", async () => {
    const beforeItem = item();
    const canonical = {
      pickClaimLine: vi.fn()
        .mockRejectedValueOnce(codedError("CLAIM_PICK_LOCATION_SHORTFALL"))
        .mockRejectedValueOnce(codedError("CLAIM_RECONCILIATION_SOURCE_SHORTFALL")),
      unpickClaimLine: vi.fn(),
    };
    const context = canonicalContext(canonical);
    const storage = {
      getProductVariantBySku: vi.fn(async () => ({
        id: 105,
        requiresShipping: true,
        trackInventory: true,
      })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{
        warehouseLocationId: 1,
        variantQty: 1,
      }]),
      getAllWarehouseLocations: vi.fn(async () => [{
        id: 1,
        code: "A-01",
        warehouseId: 1,
        isPickable: 1,
        isActive: 1,
        cycleCountFreezeId: null,
        locationType: "pick",
      }]),
    };
    const inventoryCore = { pickItem: vi.fn() };
    const service = new PickingUseCases(
      {} as any,
      inventoryCore as any,
      {} as any,
      storage as any,
    );

    await expect((service as any).completeCanonicalPick(context, {
      itemId: 500,
      beforeItem,
      effectivePickedQuantity: 1,
      warehouseId: 1,
      pickMethod: "scan",
    })).rejects.toMatchObject({ code: "CLAIM_RECONCILIATION_SOURCE_SHORTFALL" });

    expect(canonical.pickClaimLine.mock.calls.map(([command]) => command.locationStrategy)).toEqual([
      "strict",
      "reconcile_recorded_stock",
    ]);
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
  });

  it("routes a completed inventory unpick through exact canonical pick lineage", async () => {
    const beforeItem = item({ status: "completed", quantity: 2, pickedQuantity: 2 });
    const updatedItem = item({ status: "in_progress", quantity: 2, pickedQuantity: 1 });
    const canonical = {
      pickClaimLine: vi.fn(),
      unpickClaimLine: vi.fn(async () => ({
        outcome: "unpicked",
        warehouseLocationIds: [1],
      })),
    };
    const context = canonicalContext(canonical);
    const runtimeExecutor = executor(context);
    const db = { transaction: vi.fn() };
    const inventoryCore = {
      unpickItem: vi.fn(),
      getLevel: vi.fn(async () => ({ variantQty: 5 })),
    };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(updatedItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "in_progress",
        assignedPickerId: "picker-1",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => ({
        id: 105,
        requiresShipping: true,
        trackInventory: true,
      })),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01" }]),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.unpickItem(500, {
      qty: 1,
      userId: "picker-1",
      reason: "correct scan",
    })).resolves.toMatchObject({
      success: true,
      item: { status: "in_progress", pickedQuantity: 1 },
      inventory: {
        locationId: 1,
        systemQtyAfter: 5,
        resolution: { code: "unpick_reversed" },
      },
    });

    expect(context.getClaimOwningPickedLine).toHaveBeenCalledWith(900, 500);
    expect(context.getClaimLinePickMovementCursor).toHaveBeenCalledWith("9", 500);
    expect(canonical.unpickClaimLine).toHaveBeenCalledWith(expect.objectContaining({
      claimId: "9",
      orderItemId: 500,
      quantity: "1",
      wmsProgress: {
        expectedStatus: "completed",
        expectedPickedQuantity: 2,
        targetStatus: "in_progress",
        targetPickedQuantity: 1,
      },
      idempotencyKey: expect.stringMatching(/^inventory-picker-runtime:unpick:[a-f0-9]{64}$/),
    }));
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("keeps reversing canonical inventory after a partial unpick even if the catalog mapping disappears", async () => {
    const beforeItem = item({ status: "in_progress", quantity: 2, pickedQuantity: 1 });
    const updatedItem = item({ status: "pending", quantity: 2, pickedQuantity: 0 });
    const canonical = {
      pickClaimLine: vi.fn(),
      unpickClaimLine: vi.fn(async () => ({
        outcome: "unpicked",
        warehouseLocationIds: [1],
      })),
    };
    const context = canonicalContext(canonical);
    context.getClaimLinePickMovementCursor = vi.fn(async () => "33");
    const runtimeExecutor = executor(context);
    const db = { transaction: vi.fn() };
    const inventoryCore = {
      unpickItem: vi.fn(),
      getLevel: vi.fn(),
    };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(updatedItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "in_progress",
        assignedPickerId: "picker-1",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => null),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01" }]),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.unpickItem(500, {
      qty: 1,
      userId: "picker-1",
      reason: "finish correction",
    })).resolves.toMatchObject({
      success: true,
      item: { status: "pending", pickedQuantity: 0 },
    });

    expect(canonical.unpickClaimLine).toHaveBeenCalledWith(expect.objectContaining({
      claimId: "9",
      orderItemId: 500,
      quantity: "1",
      wmsProgress: {
        expectedStatus: "in_progress",
        expectedPickedQuantity: 1,
        targetStatus: "pending",
        targetPickedQuantity: 0,
      },
    }));
    expect(context.getClaimLinePickMovementCursor).toHaveBeenCalledWith("9", 500);
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(inventoryCore.getLevel).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("unpicks a digital item as WMS progress without invoking canonical or legacy inventory", async () => {
    const beforeItem = item({
      sku: "DIGITAL-1",
      name: "Digital entitlement",
      status: "completed",
      pickedQuantity: 1,
      requiresShipping: 0,
      location: null,
    });
    const updatedItem = item({
      ...beforeItem,
      status: "pending",
      pickedQuantity: 0,
      pickedAt: null,
    });
    const updateCalls: Array<Record<string, unknown>> = [];
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ warehouse_status: "in_progress", on_hold: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: 500, status: "completed", picked_quantity: 1, quantity: 1 }] }),
      update: vi.fn(() => ({
        set: vi.fn((updates: Record<string, unknown>) => {
          updateCalls.push(updates);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [updatedItem]),
            })),
          };
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [updatedItem]),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(async (work: (selected: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const canonical = { pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() };
    const runtimeExecutor = executor(canonicalContext(canonical));
    const inventoryCore = { unpickItem: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "in_progress",
        assignedPickerId: "picker-1",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => ({
        id: 901,
        requiresShipping: false,
        trackInventory: false,
      })),
      getAllWarehouseLocations: vi.fn(),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.unpickItem(500, { qty: 1, userId: "picker-1" }))
      .resolves.toMatchObject({
        success: true,
        item: { status: "pending", pickedQuantity: 0 },
      });

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(canonical.unpickClaimLine).not.toHaveBeenCalled();
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(updateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "pending", pickedQuantity: 0, pickedAt: null }),
      expect.objectContaining({ pickedCount: 0, itemCount: 1, unitCount: 1 }),
    ]));
  });
});
