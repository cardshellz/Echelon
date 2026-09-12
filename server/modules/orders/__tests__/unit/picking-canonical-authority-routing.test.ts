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

  it.each(["strict", "reconcile_picker_observation"] as const)("completes existing partial custody with only the remaining delta (%s)", async (strategy) => {
    const beforeItem = item({ quantity: 6, pickedQuantity: 2, status: "in_progress", location: "UNASSIGNED" });
    const pickClaimLine = vi.fn();
    if (strategy === "reconcile_picker_observation") {
      pickClaimLine.mockRejectedValueOnce(codedError("CLAIM_PICK_LOCATION_SHORTFALL"))
        .mockRejectedValueOnce(codedError("CLAIM_LEVEL_CONFLICT"));
    }
    pickClaimLine.mockResolvedValue({ outcome: "picked", warehouseLocationIds: [1] });
    const context = canonicalContext({ pickClaimLine });
    const storage = {
      getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: "P5", requiresShipping: true, trackInventory: true })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 1, variantQty: 4 }]),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01", warehouseId: 1,
        isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
      getOrderItemById: vi.fn(async () => ({ ...beforeItem, pickedQuantity: 6, status: "completed" })),
    };
    const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 0 })) } as any,
      {} as any, storage as any);
    await (service as any).applyCanonicalPickProgress(context, { itemId: 500, beforeItem,
      status: "completed", effectivePickedQuantity: 6, warehouseId: 1, userId: "picker", pickMethod: "scan" });
    expect(pickClaimLine).toHaveBeenLastCalledWith(expect.objectContaining({
      quantity: "4", locationStrategy: strategy,
      wmsProgress: { expectedStatus: "in_progress", expectedPickedQuantity: 2,
        targetStatus: "completed", targetPickedQuantity: 6, targetShortReason: null },
      ...(strategy === "reconcile_picker_observation" ? { observation: expect.objectContaining({ observedPhysicalQty: "4" }) } : {}),
    }));
    expect(pickClaimLine.mock.calls.every(([command]) => command.quantity === "4")).toBe(true);
  });

  it("commits a positive partial-short delta with its reason in canonical WMS progress", async () => {
    const beforeItem = item({ quantity: 6, pickedQuantity: 2, status: "in_progress" });
    const shortItem = item({ quantity: 6, pickedQuantity: 4, status: "short", shortReason: "partial" });
    const pickClaimLine = vi.fn(async () => ({ outcome: "picked", warehouseLocationIds: [1] }));
    const context = canonicalContext({ pickClaimLine });
    const storage = {
      getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: "P5", requiresShipping: true, trackInventory: true })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 1, variantQty: 4 }]),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01", warehouseId: 1,
        isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
      getOrderItemById: vi.fn(async () => shortItem),
    };
    const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 2 })) } as any,
      {} as any, storage as any);

    await (service as any).applyCanonicalPickProgress(context, {
      itemId: 500,
      beforeItem,
      status: "short",
      effectivePickedQuantity: 4,
      shortReason: "partial",
      warehouseId: 1,
      userId: "picker",
      pickMethod: "short",
    });

    expect(pickClaimLine).toHaveBeenCalledWith(expect.objectContaining({
      quantity: "2",
      wmsProgress: {
        expectedStatus: "in_progress",
        expectedPickedQuantity: 2,
        targetStatus: "short",
        targetPickedQuantity: 4,
        targetShortReason: "partial",
      },
    }));
  });

  it("posts an in-progress picker increment through canonical claim custody", async () => {
    const beforeItem = item({ quantity: 3, pickedQuantity: 0, status: "pending" });
    const updatedItem = item({ quantity: 3, pickedQuantity: 1, status: "in_progress", pickedAt: new Date() });
    const canonical = {
      pickClaimLine: vi.fn(async () => ({ outcome: "picked", warehouseLocationIds: [1] })),
      unpickClaimLine: vi.fn(),
    };
    const runtimeExecutor = executor(canonicalContext(canonical));
    const db = { transaction: vi.fn(), insert: vi.fn() };
    const inventoryCore = { getLevel: vi.fn(async () => ({ variantQty: 4 })) };
    const replenishment = { createAndExecuteReplen: vi.fn(async () => null) };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(updatedItem),
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
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 1, variantQty: 5 }]),
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
        postPickStatus: "in_progress",
        pickMode: "single_order",
        requireScanConfirm: 0,
      }]),
      updateOrderProgress: vi.fn(async () => ({ id: 900, warehouseStatus: "in_progress" })),
    };
    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      replenishment as any,
      storage as any,
      channelSync,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.pickItem(500, {
      status: "in_progress",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
    })).resolves.toMatchObject({
      success: true,
      item: { status: "in_progress", pickedQuantity: 1 },
      inventory: { deducted: true, locationId: 1 },
    });
    expect(canonical.pickClaimLine).toHaveBeenCalledWith(expect.objectContaining({
      quantity: "1",
      wmsProgress: {
        expectedStatus: "pending",
        expectedPickedQuantity: 0,
        targetStatus: "in_progress",
        targetPickedQuantity: 1,
        targetShortReason: null,
      },
    }));
    expect(replenishment.createAndExecuteReplen).toHaveBeenCalledOnce();
    expect(channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(105);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("suppresses duplicate picker side effects when canonical custody reports an idempotent replay", async () => {
    const beforeItem = item({ quantity: 3, pickedQuantity: 0, status: "pending" });
    const committedItem = item({
      quantity: 3,
      pickedQuantity: 1,
      status: "in_progress",
      pickedAt: new Date("2026-09-11T12:00:00.000Z"),
    });
    const canonical = {
      pickClaimLine: vi.fn(async () => ({
        outcome: "picked",
        warehouseLocationIds: [1],
        idempotentReplay: true,
      })),
      unpickClaimLine: vi.fn(),
    };
    const runtimeExecutor = executor(canonicalContext(canonical));
    const inventoryCore = { getLevel: vi.fn() };
    const replenishment = { createAndExecuteReplen: vi.fn() };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(committedItem),
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
      getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 1, variantQty: 5 }]),
      getAllWarehouseLocations: vi.fn(async () => [{
        id: 1,
        code: "A-01",
        warehouseId: 1,
        isPickable: 1,
        isActive: 1,
        cycleCountFreezeId: null,
        locationType: "pick",
      }]),
      createPickingLog: vi.fn(),
      getAllWarehouseSettings: vi.fn(),
      updateOrderProgress: vi.fn(),
    };
    const service = new PickingUseCases(
      { transaction: vi.fn() } as any,
      inventoryCore as any,
      replenishment as any,
      storage as any,
      channelSync as any,
      undefined,
      false,
      runtimeExecutor as any,
    );

    await expect(service.pickItem(500, {
      status: "in_progress",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
    })).resolves.toMatchObject({
      success: true,
      item: { status: "in_progress", pickedQuantity: 1 },
    });

    expect(inventoryCore.getLevel).not.toHaveBeenCalled();
    expect(replenishment.createAndExecuteReplen).not.toHaveBeenCalled();
    expect(channelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(storage.createPickingLog).not.toHaveBeenCalled();
    expect(storage.getAllWarehouseSettings).not.toHaveBeenCalled();
    expect(storage.updateOrderProgress).not.toHaveBeenCalled();
  });

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
    const replenishment = { createAndExecuteReplen: vi.fn(async () => null) };
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
        targetShortReason: null,
      },
      idempotencyKey: expect.stringMatching(/^inventory-picker-runtime:pick-reconcile_picker_observation:[a-f0-9]{64}$/),
    }));
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(replenishment.createAndExecuteReplen).toHaveBeenCalledWith(105, 1, "picker-1", {
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      blocksShipment: false,
    });
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
      status: "completed",
      effectivePickedQuantity: 1,
      warehouseId: 1,
      userId: "picker-1",
      pickMethod: "scan",
    };

    await (service as any).applyCanonicalPickProgress(context, command);
    await (service as any).applyCanonicalPickProgress(context, command);

    const firstKey = canonical.pickClaimLine.mock.calls[0]?.[0]?.idempotencyKey;
    const secondKey = canonical.pickClaimLine.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstKey).toMatch(/^inventory-picker-runtime:pick-strict:[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^inventory-picker-runtime:pick-strict:[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
  });

  it("rejects a stale full-quantity active row instead of certifying unproven custody", async () => {
    const beforeItem = item({ pickedQuantity: 1, status: "pending" });
    const completedItem = item({ pickedQuantity: 1, status: "completed", pickedAt: new Date() });
    const legacyDb = { execute: vi.fn() };
    const context = {
      ...canonicalContext({ pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() }),
      authority: "legacy" as const,
      activationRunId: null,
      legacyDb,
    };
    const runtimeExecutor = executor(context);
    const db = { transaction: vi.fn(), execute: vi.fn(async () => ({ rows: [] })) };
    const inventoryCore = { withTx: vi.fn(), pickItem: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      updateOrderItemStatus: vi.fn(async () => completedItem),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseId: 1,
        warehouseStatus: "ready",
        onHold: 0,
      })),
      getUser: vi.fn(async () => null),
      createPickingLog: vi.fn(async () => ({})),
      getAllWarehouseSettings: vi.fn(async () => []),
      getOrderItems: vi.fn(async () => [completedItem]),
      updateOrderProgress: vi.fn(async () => ({ id: 900, warehouseStatus: "ready_to_ship" })),
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
    })).resolves.toMatchObject({
      success: false,
      error: "pick_custody_reconfirmation_required",
    });

    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expect(runtimeExecutor.execute).not.toHaveBeenCalled();
    expect(legacyDb.execute).not.toHaveBeenCalled();
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

    await expect((service as any).applyCanonicalPickProgress(context, {
      itemId: 500,
      beforeItem,
      status: "completed",
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

  it.each([
    { sourceStatus: "completed", quantity: 2 },
    { sourceStatus: "short", quantity: 3 },
  ] as const)("routes a $sourceStatus inventory unpick through exact canonical pick lineage", async ({
    sourceStatus,
    quantity,
  }) => {
    const beforeItem = item({ status: sourceStatus, quantity, pickedQuantity: 2 });
    const updatedItem = item({ status: "in_progress", quantity, pickedQuantity: 1 });
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
        expectedStatus: sourceStatus,
        expectedPickedQuantity: 2,
        targetStatus: "in_progress",
        targetPickedQuantity: 1,
      },
      idempotencyKey: expect.stringMatching(/^inventory-picker-runtime:unpick:[a-f0-9]{64}$/),
    }));
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("suppresses duplicate unpick logging when canonical custody reports a replay", async () => {
    const beforeItem = item({ status: "completed", quantity: 2, pickedQuantity: 2 });
    const committedItem = item({ status: "in_progress", quantity: 2, pickedQuantity: 1 });
    const canonical = {
      pickClaimLine: vi.fn(),
      unpickClaimLine: vi.fn(async () => ({
        outcome: "unpicked",
        warehouseLocationIds: [1],
        idempotentReplay: true,
      })),
    };
    const context = canonicalContext(canonical);
    const runtimeExecutor = executor(context);
    const inventoryCore = { unpickItem: vi.fn(), getLevel: vi.fn() };
    const storage = {
      getOrderItemById: vi.fn()
        .mockResolvedValueOnce(beforeItem)
        .mockResolvedValueOnce(committedItem),
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
      getAllWarehouseLocations: vi.fn(),
      getUser: vi.fn(),
      createPickingLog: vi.fn(),
    };
    const service = new PickingUseCases(
      { transaction: vi.fn() } as any,
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
    });

    expect(canonical.unpickClaimLine).toHaveBeenCalledOnce();
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(inventoryCore.getLevel).not.toHaveBeenCalled();
    expect(storage.createPickingLog).not.toHaveBeenCalled();
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

  it.each([
    { name: "backed progress", status: "in_progress", costQuantity: 2, expectedPhysicalUnpick: 1 },
    { name: "backed short progress", status: "short", costQuantity: 2, expectedPhysicalUnpick: 1 },
    { name: "one legacy unbacked unit", status: "in_progress", costQuantity: 1, expectedPhysicalUnpick: 0 },
  ])("decrements $name without manufacturing on-hand inventory", async ({
    status,
    costQuantity,
    expectedPhysicalUnpick,
  }) => {
    const beforeItem = item({ status, quantity: 3, pickedQuantity: 2 });
    const updatedItem = item({ status: "in_progress", quantity: 3, pickedQuantity: 1 });
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [updatedItem]) })),
    }));
    const update = vi.fn(() => ({
      set,
    }));
    const legacyDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ warehouse_status: "in_progress", on_hold: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: 500, status, picked_quantity: 2, quantity: 3 }] }),
      update,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [updatedItem]),
        })),
      })),
    };
    const context = {
      ...canonicalContext({ pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() }),
      authority: "legacy" as const,
      activationRunId: null,
      legacyDb,
    };
    const runtimeExecutor = executor(context);
    const txInventoryCore = {
      getOrderItemPickedCostQuantity: vi.fn(async () => costQuantity),
      unpickItem: vi.fn(async () => true),
    };
    const inventoryCore = {
      withTx: vi.fn(() => txInventoryCore),
    };
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
        id: 105,
        requiresShipping: true,
        trackInventory: true,
      })),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01" }]),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases(
      { transaction: vi.fn() } as any,
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
      reason: "correct picked quantity",
    })).resolves.toMatchObject({
      success: true,
      item: { status: "in_progress", pickedQuantity: 1 },
    });

    expect(txInventoryCore.getOrderItemPickedCostQuantity).toHaveBeenCalledWith({
      orderId: 900,
      orderItemId: 500,
      productVariantId: 105,
    });
    if (expectedPhysicalUnpick > 0) {
      expect(txInventoryCore.unpickItem).toHaveBeenCalledWith(expect.objectContaining({
        qty: expectedPhysicalUnpick,
        orderId: 900,
        orderItemId: 500,
        productVariantId: 105,
        warehouseLocationId: 1,
      }));
      expect(storage.getAllWarehouseLocations).toHaveBeenCalledOnce();
    } else {
      expect(txInventoryCore.unpickItem).not.toHaveBeenCalled();
      expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    }
    if (status === "short") {
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ shortReason: null }));
    }
  });

  it("rejects a legacy unpick when another request changed progress before the row lock", async () => {
    const beforeItem = item({ status: "in_progress", quantity: 3, pickedQuantity: 2 });
    const legacyDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ warehouse_status: "in_progress", on_hold: 0 }] })
        .mockResolvedValueOnce({ rows: [{
          id: 500,
          status: "in_progress",
          picked_quantity: 1,
          quantity: 3,
          short_reason: null,
          picked_at: new Date("2026-09-11T12:00:00.000Z"),
        }] }),
      update: vi.fn(),
    };
    const context = {
      ...canonicalContext({ pickClaimLine: vi.fn(), unpickClaimLine: vi.fn() }),
      authority: "legacy" as const,
      activationRunId: null,
      legacyDb,
    };
    const runtimeExecutor = executor(context);
    const txInventoryCore = {
      getOrderItemPickedCostQuantity: vi.fn(),
      unpickItem: vi.fn(),
    };
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
        id: 105,
        requiresShipping: true,
        trackInventory: true,
      })),
      createPickingLog: vi.fn(),
    };
    const service = new PickingUseCases(
      { transaction: vi.fn() } as any,
      { withTx: vi.fn(() => txInventoryCore) } as any,
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
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({
        reason: "unpick_progress_conflict",
        expectedPickedQuantity: 2,
        actualPickedQuantity: 1,
      }),
    });

    expect(txInventoryCore.getOrderItemPickedCostQuantity).not.toHaveBeenCalled();
    expect(txInventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(legacyDb.update).not.toHaveBeenCalled();
    expect(storage.createPickingLog).not.toHaveBeenCalled();
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
