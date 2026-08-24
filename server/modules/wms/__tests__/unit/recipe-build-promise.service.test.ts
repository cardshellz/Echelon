import { describe, expect, it, vi } from "vitest";

import { createRecipeBuildPromiseService } from "../../application/recipe-build-promise.service";

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 500,
    warehouse_id: 1,
    warehouse_status: "confirmed",
    order_item_id: 600,
    sku: "QUAD-BOX-TOP-P5",
    persisted_variant_id: 50,
    quantity: 2,
    on_hold: false,
    hold_reason: null,
    catalog_product_id: 5,
    variant_is_active: true,
    ...overrides,
  };
}

function makeExecutor(rowSets: any[][]) {
  const pending = rowSets.slice();
  const returning = vi.fn(async () => [{ id: 600 }]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const execute = vi.fn(async () => ({ rows: pending.shift() ?? [] }));
  return { execute, update, set, where, returning };
}

function makeDependencies() {
  const recipeCapacity = {
    getGraphProductIds: vi.fn(async () => [5]),
    planDemand: vi.fn(),
  };
  const builds = {
    createOrder: vi.fn(),
    linkDependency: vi.fn(async () => undefined),
    releaseOrder: vi.fn(async () => undefined),
    cancelOrder: vi.fn(async () => ({
      buildOrderId: 1,
      systemNumber: "BLD-1",
      status: "cancelled" as const,
      releasedReservationQty: 0,
      alreadyCancelled: false,
    })),
  };
  const inventoryCore = {
    reserveForOrder: vi.fn(async () => true),
  };
  return { recipeCapacity, builds, inventoryCore };
}

describe("RecipeBuildPromiseService", () => {
  it("reserves finished goods directly when the demand plan needs no build", async () => {
    const tx = makeExecutor([[orderRow()], [], []]);
    const deps = makeDependencies();
    deps.recipeCapacity.planDemand.mockResolvedValue({
      warehouseId: 1,
      targetVariantId: 50,
      requestedQty: 2,
      sourceLocationId: 700,
      directAllocations: [{ sourceLocationId: 700, qty: 2 }],
      nodes: [],
      rootNodeKey: null,
    });
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    const result = await service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
    }, tx as any);

    expect(result).toEqual({ reserved: 2, promised: 0, shortfall: 0 });
    expect(deps.inventoryCore.reserveForOrder).toHaveBeenCalledWith({
      productVariantId: 50,
      warehouseLocationId: 700,
      qty: 2,
      orderId: 500,
      orderItemId: 600,
      userId: undefined,
      referenceType: "recipe_direct",
      referenceId: "600:700",
    }, tx);
    expect(deps.builds.createOrder).not.toHaveBeenCalled();
  });

  it("creates a dependency-ordered build graph and holds the owning line", async () => {
    const tx = makeExecutor([
      [orderRow()],
      [],
      [{ reserved_qty: 0 }],
      [],
      [],
      [],
      [{ id: 77 }],
      [],
    ]);
    const deps = makeDependencies();
    deps.recipeCapacity.getGraphProductIds.mockResolvedValue([5, 6, 7]);
    deps.recipeCapacity.planDemand.mockResolvedValue({
      warehouseId: 1,
      targetVariantId: 50,
      requestedQty: 2,
      sourceLocationId: 700,
      directAllocations: [],
      rootNodeKey: "root",
      nodes: [
        {
          nodeKey: "root.1",
          recipeId: 10,
          outputVariantId: 40,
          outputLocationId: 701,
          plannedBuilds: 10,
          outputQty: 10,
          components: [
            { variantId: 30, requiredQty: 10, sourceLocationId: 702, prerequisiteNodeKey: null },
          ],
        },
        {
          nodeKey: "root",
          recipeId: 11,
          outputVariantId: 50,
          outputLocationId: 700,
          plannedBuilds: 2,
          outputQty: 2,
          components: [
            { variantId: 40, requiredQty: 10, sourceLocationId: 701, prerequisiteNodeKey: "root.1" },
          ],
        },
      ],
    });
    deps.builds.createOrder
      .mockResolvedValueOnce({ id: 1001 })
      .mockResolvedValueOnce({ id: 1002 });
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    const result = await service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
      actorId: "test-user",
    }, tx as any);

    expect(result).toEqual({ reserved: 0, promised: 2, shortfall: 0 });
    expect(deps.builds.createOrder).toHaveBeenCalledTimes(2);
    expect(deps.builds.linkDependency).toHaveBeenCalledWith({
      dependentBuildOrderId: 1002,
      prerequisiteBuildOrderId: 1001,
      componentVariantId: 40,
      requiredQty: 10,
    }, tx);
    expect(deps.builds.releaseOrder).toHaveBeenCalledWith(1001, "test-user", tx);
    expect(tx.set).toHaveBeenCalledWith({
      onHold: true,
      holdReason: "recipe_build_required:order_item:600",
    });
  });

  it("reserves finished stock and promises only the build shortfall", async () => {
    const tx = makeExecutor([
      [orderRow()],
      [],
      [{ reserved_qty: 0 }],
      [],
      [{ id: 77 }],
      [],
    ]);
    const deps = makeDependencies();
    deps.recipeCapacity.planDemand.mockResolvedValue({
      warehouseId: 1,
      targetVariantId: 50,
      requestedQty: 2,
      sourceLocationId: 700,
      directAllocations: [{ sourceLocationId: 703, qty: 1 }],
      rootNodeKey: "root",
      nodes: [{
        nodeKey: "root",
        recipeId: 11,
        outputVariantId: 50,
        outputLocationId: 700,
        plannedBuilds: 1,
        outputQty: 1,
        components: [
          { variantId: 40, requiredQty: 5, sourceLocationId: 701, prerequisiteNodeKey: null },
        ],
      }],
    });
    deps.builds.createOrder.mockResolvedValue({ id: 1002 });
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    const result = await service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
      actorId: "test-user",
    }, tx as any);

    expect(result).toEqual({ reserved: 1, promised: 1, shortfall: 0 });
    expect(deps.inventoryCore.reserveForOrder).toHaveBeenCalledWith({
      productVariantId: 50,
      warehouseLocationId: 703,
      qty: 1,
      orderId: 500,
      orderItemId: 600,
      userId: "test-user",
      referenceType: "recipe_direct",
      referenceId: "600:703",
    }, tx);
    expect(deps.builds.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      plannedBuilds: 1,
    }), tx);
  });

  it("reuses an awaiting demand after acquiring the order-item lock", async () => {
    const tx = makeExecutor([
      [orderRow()],
      [{
        id: 77,
        order_id: 500,
        order_item_id: 600,
        target_variant_id: 50,
        requested_qty: 2,
        promised_qty: 2,
        status: "awaiting_build",
      }],
    ]);
    const deps = makeDependencies();
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    const result = await service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
    }, tx as any);

    expect(result).toEqual({ reserved: 0, promised: 2, shortfall: 0 });
    expect(deps.recipeCapacity.getGraphProductIds).not.toHaveBeenCalled();
    expect(deps.builds.createOrder).not.toHaveBeenCalled();
  });

  it("rejects an existing demand whose promised quantity exceeds the order line", async () => {
    const tx = makeExecutor([
      [orderRow()],
      [{
        id: 77,
        order_id: 500,
        order_item_id: 600,
        target_variant_id: 50,
        requested_qty: 2,
        promised_qty: 3,
        status: "awaiting_build",
      }],
    ]);
    const deps = makeDependencies();
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    await expect(service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
    }, tx as any)).rejects.toMatchObject({ code: "RECIPE_PROMISE_DATA_INVALID" });

    expect(deps.recipeCapacity.getGraphProductIds).not.toHaveBeenCalled();
    expect(deps.inventoryCore.reserveForOrder).not.toHaveBeenCalled();
  });

  it("rejects a planner response for different demand before reserving inventory", async () => {
    const tx = makeExecutor([
      [orderRow()],
      [],
      [{ reserved_qty: 0 }],
      [],
    ]);
    const deps = makeDependencies();
    deps.recipeCapacity.planDemand.mockResolvedValue({
      warehouseId: 2,
      targetVariantId: 50,
      requestedQty: 2,
      sourceLocationId: 700,
      directAllocations: [{ sourceLocationId: 700, qty: 2 }],
      nodes: [],
      rootNodeKey: null,
    });
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    await expect(service.claimOrderItem({
      productId: 5,
      variantId: 50,
      orderQty: 2,
      orderId: 500,
      orderItemId: 600,
    }, tx as any)).rejects.toMatchObject({ code: "RECIPE_PROMISE_PLAN_INVALID" });

    expect(deps.inventoryCore.reserveForOrder).not.toHaveBeenCalled();
    expect(deps.builds.createOrder).not.toHaveBeenCalled();
  });

  it("releases a dependent build only after every prerequisite is complete", async () => {
    const tx = makeExecutor([
      [{ dependent_build_order_id: 1002 }],
      [{ incomplete_count: 0 }],
      [],
    ]);
    const deps = makeDependencies();
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    await service.reconcileBuildCompletion(tx as any, {
      buildOrderId: 1001,
      outputVariantId: 40,
      outputLocationId: 701,
      outputQty: 10,
    });

    expect(deps.builds.releaseOrder).toHaveBeenCalledWith(1002, "recipe-atp", tx);
    expect(deps.inventoryCore.reserveForOrder).not.toHaveBeenCalled();
  });

  it("reserves completed root output and clears only its owned hold", async () => {
    const tx = makeExecutor([
      [],
      [{
        id: 77,
        order_id: 500,
        order_item_id: 600,
        target_variant_id: 50,
        promised_qty: 2,
        hold_applied: true,
        demand_hold_reason: "recipe_build_required:order_item:600",
        on_hold: true,
        item_hold_reason: "recipe_build_required:order_item:600",
      }],
      [],
    ]);
    const deps = makeDependencies();
    const service = createRecipeBuildPromiseService(
      { ...tx, transaction: async (work: any) => work(tx) } as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    await service.reconcileBuildCompletion(tx as any, {
      buildOrderId: 1002,
      outputVariantId: 50,
      outputLocationId: 700,
      outputQty: 2,
    });

    expect(deps.inventoryCore.reserveForOrder).toHaveBeenCalledWith({
      productVariantId: 50,
      warehouseLocationId: 700,
      qty: 2,
      orderId: 500,
      orderItemId: 600,
      userId: "recipe-atp",
      referenceType: "recipe_build",
      referenceId: "77",
    }, tx);
    expect(tx.set).toHaveBeenCalledWith({ onHold: false, holdReason: null });
  });

  it("cancels the demand and clears a matching owned hold", async () => {
    const tx = makeExecutor([
      [{
        id: 77,
        order_item_id: 600,
        root_build_order_id: null,
        hold_applied: true,
        demand_hold_reason: "recipe_build_required:order_item:600",
        on_hold: true,
        item_hold_reason: "recipe_build_required:order_item:600",
      }],
      [],
    ]);
    const deps = makeDependencies();
    const db = { ...tx, transaction: async (work: any) => work(tx) };
    const service = createRecipeBuildPromiseService(
      db as any,
      deps.recipeCapacity as any,
      deps.builds as any,
      deps.inventoryCore,
    );

    const result = await service.cancelOrderDemands(500, "customer cancelled", "test-user");

    expect(result).toEqual({
      cancelledDemands: 1,
      cancelledBuildOrders: 0,
      failures: [],
    });
    expect(tx.set).toHaveBeenCalledWith({ onHold: false, holdReason: null });
  });
});
