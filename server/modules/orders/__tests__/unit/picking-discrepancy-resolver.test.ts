import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

function makeService(
  levels: Array<{ warehouseLocationId: number; variantQty: number }>,
  locationOverrides?: Array<Record<string, unknown>>,
  replenishmentOverrides?: Record<string, unknown>,
) {
  const locations = locationOverrides ?? [
    { id: 1, code: "A-01", isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
    { id: 2, code: "B-01", isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
  ];

  const storage = {
    getProductVariantBySku: vi.fn(async (sku: string) => ({
      id: 100,
      sku,
      productId: 10,
      unitsPerVariant: 1,
    })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => levels),
    getAllWarehouseLocations: vi.fn(async () => locations),
    getOrderById: vi.fn(async () => ({
      id: 900,
      orderNumber: "#900",
      warehouseId: 1,
      assignedPickerId: "picker-1",
    })),
    getPendingReplenTasksForLocation: vi.fn(async () => []),
    updateReplenTask: vi.fn(async () => ({})),
  };

  const inventoryCore = {
    adjustInventory: vi.fn(async (params: { warehouseLocationId: number; qtyDelta: number }) => {
      const level = levels.find(l => l.warehouseLocationId === params.warehouseLocationId);
      if (level) level.variantQty += params.qtyDelta;
      else levels.push({ warehouseLocationId: params.warehouseLocationId, variantQty: params.qtyDelta });
    }),
    pickItem: vi.fn(async (params: { warehouseLocationId: number; qty: number }) => {
      const level = levels.find(l => l.warehouseLocationId === params.warehouseLocationId);
      if (!level || level.variantQty < params.qty) return false;
      level.variantQty -= params.qty;
      return true;
    }),
    getLevel: vi.fn(async (_variantId: number, warehouseLocationId: number) => {
      const level = levels.find(l => l.warehouseLocationId === warehouseLocationId);
      return level ? { ...level, productVariantId: 100 } : null;
    }),
    logTransaction: vi.fn(async () => ({})),
  };

  const replenishment = {
    checkReplenNeeded: vi.fn(async () => ({
      needed: false,
      stockout: false,
      sourceLocationCode: null,
      sourceVariantSku: null,
      sourceVariantName: null,
      qtyTargetUnits: 0,
      replenMethod: "full_case",
      executionMode: "queue",
    })),
    createAndExecuteReplen: vi.fn(async () => null),
    ...replenishmentOverrides,
  };

  const service = new PickingUseCases({} as any, inventoryCore as any, replenishment as any, storage as any);
  return { service, storage, inventoryCore, replenishment };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    orderId: 900,
    sku: "SKU-1",
    name: "Test SKU",
    quantity: 1,
    pickedQuantity: 1,
    location: "A-01",
    status: "pending",
    shortReason: null,
    ...overrides,
  } as any;
}

function makeReadyToShipDb(params: {
  exceptions?: Array<Record<string, unknown>>;
  replenTasks?: Array<Record<string, unknown>>;
} = {}) {
  return {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: params.exceptions ?? [] })
      .mockResolvedValueOnce({ rows: params.replenTasks ?? [] }),
  };
}

function makePickItemHarness(replenResult: { task: any; moved: number } | null) {
  const levels = [
    { warehouseLocationId: 1, variantQty: 3 },
  ];
  const locations = [
    { id: 1, code: "A-01", isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
  ];
  const beforeItem = makeItem({ status: "pending", pickedQuantity: 0, quantity: 1 });
  const updatedItem = {
    ...beforeItem,
    status: "completed",
    pickedQuantity: 1,
    pickedAt: new Date(),
  };

  const tx = {
    execute: vi.fn(async () => ({ rows: [{ status: "pending" }] })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [updatedItem]),
        })),
      })),
    })),
  };
  const db = {
    transaction: vi.fn(async (callback: (txArg: any) => Promise<any>) => callback(tx)),
  };

  const inventoryCore: any = {};
  Object.assign(inventoryCore, {
    withTx: vi.fn(() => inventoryCore),
    adjustInventory: vi.fn(async () => ({})),
    pickItem: vi.fn(async (params: { warehouseLocationId: number; qty: number }) => {
      const level = levels.find(l => l.warehouseLocationId === params.warehouseLocationId);
      if (!level || level.variantQty < params.qty) return false;
      level.variantQty -= params.qty;
      return true;
    }),
    getLevel: vi.fn(async (_variantId: number, warehouseLocationId: number) => {
      const level = levels.find(l => l.warehouseLocationId === warehouseLocationId);
      return level ? { ...level, productVariantId: 100 } : null;
    }),
  });

  const storage = {
    getOrderItemById: vi.fn(async () => beforeItem),
    getProductVariantBySku: vi.fn(async (sku: string) => ({
      id: 100,
      sku,
      productId: 10,
      unitsPerVariant: 1,
    })),
    getProductVariantById: vi.fn(async (id: number) => ({
      id,
      sku: "SKU-1",
      name: "Each",
      productId: 10,
      unitsPerVariant: 1,
      hierarchyLevel: 0,
    })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => levels.map(level => ({ ...level }))),
    getAllWarehouseLocations: vi.fn(async () => locations),
    getOrderById: vi.fn(async () => ({
      id: 900,
      orderNumber: "#900",
      assignedPickerId: "picker-1",
    })),
    getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
    createPickingLog: vi.fn(async () => ({})),
    getAllWarehouseSettings: vi.fn(async () => [{
      warehouseId: 1,
      postPickStatus: "completed",
      pickMode: "single_order",
      requireScanConfirm: 0,
    }]),
    updateOrderProgress: vi.fn(async () => ({
      id: 900,
      orderNumber: "#900",
      warehouseStatus: "completed",
    })),
  };
  const replenishment = {
    createAndExecuteReplen: vi.fn(async () => replenResult),
  };

  const service = new PickingUseCases(db as any, inventoryCore as any, replenishment as any, storage as any);
  return { service, db, tx, inventoryCore, storage, replenishment };
}

function makePickNoopHarness(beforeItem: any) {
  const storage = {
    getOrderItemById: vi.fn(async () => beforeItem),
    getOrderById: vi.fn(async () => ({
      id: beforeItem.orderId,
      orderNumber: "#900",
      warehouseId: 1,
      assignedPickerId: "picker-1",
    })),
    getUser: vi.fn(async (id: string) => ({ id, username: "picker", role: "picker" })),
    updateOrderItemStatus: vi.fn(),
    createPickingLog: vi.fn(),
  };
  const service = new PickingUseCases({} as any, {} as any, {} as any, storage as any);
  return { service, storage };
}

function expectPickCommandRejectedLog(
  storage: { createPickingLog: ReturnType<typeof vi.fn> },
  beforeItem: any,
  rejectionCode: string,
  requested: Record<string, unknown>,
) {
  expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
    actionType: "pick_command_rejected",
    pickerId: "picker-1",
    pickerName: "picker",
    pickerRole: "picker",
    orderId: beforeItem.orderId,
    orderNumber: "#900",
    orderItemId: beforeItem.id,
    sku: beforeItem.sku,
    itemName: beforeItem.name,
    locationCode: beforeItem.location,
    qtyRequested: beforeItem.quantity,
    qtyBefore: beforeItem.pickedQuantity || 0,
    qtyAfter: beforeItem.pickedQuantity || 0,
    qtyDelta: 0,
    reason: rejectionCode,
    itemStatusBefore: beforeItem.status,
    itemStatusAfter: beforeItem.status,
    metadata: expect.objectContaining({
      requested: expect.objectContaining(requested),
      before: expect.objectContaining({
        status: beforeItem.status,
        pickedQuantity: beforeItem.pickedQuantity || 0,
        quantity: beforeItem.quantity,
      }),
      rejectionCode,
      commandUserId: "picker-1",
    }),
  }));
}

describe("PickingUseCases pick progress validation", () => {
  it("rejects a pending pick request that does not change quantity or status", async () => {
    const beforeItem = makeItem({ status: "pending", pickedQuantity: 0, quantity: 1 });
    const { service, storage } = makePickNoopHarness(beforeItem);

    const result = await service.pickItem(beforeItem.id, {
      status: "pending",
      pickedQuantity: 0,
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toEqual({
      success: false,
      error: "no_pick_progress",
      message: `Pick request did not change item ${beforeItem.id}`,
    });
    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expectPickCommandRejectedLog(storage, beforeItem, "no_pick_progress", {
      status: "pending",
      pickedQuantity: 0,
      pickMethod: "manual",
    });
  });

  it("rejects an in-progress pick request that repeats the current picked quantity", async () => {
    const beforeItem = makeItem({ status: "in_progress", pickedQuantity: 5, quantity: 6 });
    const { service, storage } = makePickNoopHarness(beforeItem);

    const result = await service.pickItem(beforeItem.id, {
      status: "in_progress",
      pickedQuantity: 5,
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: "no_pick_progress",
    });
    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expectPickCommandRejectedLog(storage, beforeItem, "no_pick_progress", {
      status: "in_progress",
      pickedQuantity: 5,
      pickMethod: "manual",
    });
  });

  it("rejects an in-progress pick request that carries zero picked quantity", async () => {
    const beforeItem = makeItem({ status: "pending", pickedQuantity: 0, quantity: 6 });
    const { service, storage } = makePickNoopHarness(beforeItem);

    const result = await service.pickItem(beforeItem.id, {
      status: "in_progress",
      pickedQuantity: 0,
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toEqual({
      success: false,
      error: "in_progress_requires_positive_quantity",
      message: "In-progress picks must have a positive pickedQuantity",
    });
    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expectPickCommandRejectedLog(storage, beforeItem, "in_progress_requires_positive_quantity", {
      status: "in_progress",
      pickedQuantity: 0,
      pickMethod: "manual",
    });
  });

  it("rejects completed pick requests that do not pick the full line quantity", async () => {
    const beforeItem = makeItem({ status: "in_progress", pickedQuantity: 5, quantity: 6 });
    const { service, storage } = makePickNoopHarness(beforeItem);

    const result = await service.pickItem(beforeItem.id, {
      status: "completed",
      pickedQuantity: 5,
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toEqual({
      success: false,
      error: "completion_requires_full_quantity",
      message: "Completed picks must set pickedQuantity to the full item quantity (6)",
    });
    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expectPickCommandRejectedLog(storage, beforeItem, "completion_requires_full_quantity", {
      status: "completed",
      pickedQuantity: 5,
      pickMethod: "manual",
    });
  });
});

describe("PickingUseCases inventory discrepancy resolution", () => {
  it("auto-corrects an assigned bin shortage only when the pick was scan-verified", async () => {
    const { service, inventoryCore } = makeService([
      { warehouseLocationId: 1, variantQty: 0 },
      { warehouseLocationId: 2, variantQty: 10 },
    ]);

    const result = await (service as any)._deductInventory(makeItem(), makeItem(), {
      pickMethod: "scan",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: true,
      productVariantId: 100,
      locationId: 1,
      autoResolved: {
        code: "picker_scan_bin_shortage",
        adjustment: 1,
        systemQtyBefore: 0,
        pickedQty: 1,
      },
    });
    expect(inventoryCore.adjustInventory).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 1,
      qtyDelta: 1,
      userId: "picker-1",
    }));
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 1,
      qty: 1,
    }));
  });

  it("records a picker-confirmed variance for manual or button picks", async () => {
    const { service, inventoryCore } = makeService([
      { warehouseLocationId: 1, variantQty: 0 },
      { warehouseLocationId: 2, variantQty: 10 },
    ]);

    const result = await (service as any)._deductInventory(makeItem(), makeItem(), {
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: true,
      locationId: 1,
      autoResolved: {
        code: "picker_confirmed_bin_shortage",
        adjustment: 1,
        systemQtyBefore: 0,
        pickedQty: 1,
      },
    });
    expect(inventoryCore.adjustInventory).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 1,
      qtyDelta: 1,
      userId: "picker-1",
    }));
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 1,
      qty: 1,
    }));
  });

  it("executes inline case-break replen before picker-confirmed variance correction", async () => {
    const levels = [
      { warehouseLocationId: 1, variantQty: 0 },
    ];
    const { service, inventoryCore, replenishment } = makeService(
      levels,
      undefined,
      {
        checkReplenNeeded: vi.fn(async () => ({
          needed: true,
          stockout: false,
          sourceLocationCode: "R-01",
          sourceVariantSku: "SKU-CASE",
          sourceVariantName: "Case",
          qtyTargetUnits: 12,
          replenMethod: "case_break",
          executionMode: "inline",
        })),
        createAndExecuteReplen: vi.fn(async () => {
          levels[0].variantQty += 12;
          return { task: { id: 300, status: "completed", replenMethod: "case_break" }, moved: 12 };
        }),
      },
    );

    const result = await (service as any)._deductInventory(makeItem(), makeItem(), {
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: true,
      locationId: 1,
      prePickReplen: {
        task: { id: 300, status: "completed" },
        moved: 12,
      },
    });
    expect(replenishment.createAndExecuteReplen).toHaveBeenCalledWith(100, 1, "picker-1", expect.objectContaining({
      blocksShipment: false,
      forceWhenAtOrBelowZero: true,
      triggeredBy: "pick_shortage_case_break",
    }));
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 1,
      qty: 1,
    }));
  });

  it("resolves duplicate location codes within the order warehouse", async () => {
    const { service, inventoryCore } = makeService(
      [
        { warehouseLocationId: 10, variantQty: 0 },
        { warehouseLocationId: 20, variantQty: 5 },
      ],
      [
        { id: 10, code: "A-01", warehouseId: 2, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
        { id: 20, code: "A-01", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
      ],
    );

    const result = await (service as any)._deductInventory(makeItem(), makeItem(), {
      pickMethod: "manual",
      warehouseId: 1,
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: true,
      locationId: 20,
      locationCode: "A-01",
      systemQtyAfter: 4,
    });
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 20,
      qty: 1,
    }));
  });

  it("uses the stock-bearing active pick bin when duplicate codes lack order warehouse scope", async () => {
    const { service, inventoryCore } = makeService(
      [
        { warehouseLocationId: 10, variantQty: 0 },
        { warehouseLocationId: 20, variantQty: 5 },
      ],
      [
        { id: 10, code: "FLOOR-01", warehouseId: 35, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "storage" },
        { id: 20, code: "FLOOR-01", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
      ],
    );

    const item = makeItem({ location: "FLOOR-01" });
    const result = await (service as any)._deductInventory(item, item, {
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: true,
      locationId: 20,
      locationCode: "FLOOR-01",
      systemQtyAfter: 4,
    });
    expect(inventoryCore.pickItem).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 20,
      qty: 1,
    }));
  });
});

describe("PickingUseCases ready-to-ship guard", () => {
  it("blocks ready-to-ship when a shipment-blocking exception is open", async () => {
    const db = makeReadyToShipDb({
      exceptions: [{
        id: 77,
        sku: "SKU-1",
        exception_type: "inventory_deduction_failed",
        status: "blocked",
        review_reason: "System inventory did not match picker observation",
      }],
    });
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "completed" })),
      getOrderItems: vi.fn(async () => [{
        id: 500,
        orderId: 900,
        sku: "SKU-1",
        quantity: 1,
        pickedQuantity: 1,
        status: "completed",
        requiresShipping: 1,
        location: "A-01",
      }]),
      updateOrderStatus: vi.fn(),
      getUser: vi.fn(),
      createPickingLog: vi.fn(),
    };

    const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any);

    await expect(service.markReadyToShip(900, "lead-1")).rejects.toMatchObject({
      name: "ValidationError",
    });
    expect(storage.updateOrderStatus).not.toHaveBeenCalled();
  });

  it("allows ready-to-ship when completed shippable items have no shipment blockers", async () => {
    const db = makeReadyToShipDb();
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "completed", assignedPickerId: "picker-1" })),
      getOrderItems: vi.fn(async () => [{
        id: 500,
        orderId: 900,
        sku: "SKU-1",
        quantity: 1,
        pickedQuantity: 1,
        status: "completed",
        requiresShipping: 1,
        location: "A-01",
      }]),
      updateOrderStatus: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "ready_to_ship", assignedPickerId: "picker-1" })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };

    const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any);
    const order = await service.markReadyToShip(900, "lead-1");

    expect(order).toMatchObject({ warehouseStatus: "ready_to_ship" });
    expect(storage.updateOrderStatus).toHaveBeenCalledWith(900, "ready_to_ship");
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "order_completed",
      orderId: 900,
    }));
  });

  it("forces auto progress to exception when a shipment-blocking review exists", async () => {
    const db = makeReadyToShipDb({
      exceptions: [{
        id: 88,
        sku: "SKU-1",
        exception_type: "inventory_deduction_failed",
        status: "blocked",
        review_reason: "Inventory deduction failed",
      }],
    });
    const storage = {
      getOrderItems: vi.fn(async () => [{
        id: 500,
        orderId: 900,
        sku: "SKU-1",
        quantity: 1,
        pickedQuantity: 1,
        status: "completed",
        requiresShipping: 1,
        location: "A-01",
      }]),
    };

    const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any);
    await expect((service as any).resolvePostPickStatusForOrder(900, "ready_to_ship")).resolves.toBe("exception");
  });

  it("blocks ready-to-ship when an order-linked replen task blocks shipment", async () => {
    const db = makeReadyToShipDb({
      replenTasks: [{
        id: 121,
        sku: "SKU-1",
        status: "blocked",
        exception_reason: "source_empty",
        notes: "No source stock",
      }],
    });
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "completed" })),
      getOrderItems: vi.fn(async () => [{
        id: 500,
        orderId: 900,
        sku: "SKU-1",
        quantity: 1,
        pickedQuantity: 1,
        status: "completed",
        requiresShipping: 1,
        location: "A-01",
      }]),
      updateOrderStatus: vi.fn(),
      getUser: vi.fn(),
      createPickingLog: vi.fn(),
    };

    const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any);

    await expect(service.markReadyToShip(900, "lead-1")).rejects.toMatchObject({
      name: "ValidationError",
    });
    expect(storage.updateOrderStatus).not.toHaveBeenCalled();
  });
});

describe("PickingUseCases replen source-empty reporting", () => {
  it("records an order-linked shipment-blocking replen task without changing the item", async () => {
    const pickLocation = { id: 1, code: "A-01" };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [pickLocation]),
          })),
        })),
      })),
    };
    const storage = {
      getOrderItemById: vi.fn(async () => makeItem({ status: "pending" })),
      getProductVariantBySku: vi.fn(async () => ({ id: 100, sku: "SKU-1" })),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        assignedPickerId: "picker-1",
      })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const replenishment = {
      recordSourceEmptyBlocker: vi.fn(async () => ({ id: 121, status: "blocked" })),
    };
    const service = new PickingUseCases(db as any, {} as any, replenishment as any, storage as any);

    const result = await service.reportReplenSourceEmpty(500, {
      sourceLocationCode: "B-01",
      userId: "picker-1",
      deviceType: "scanner",
      sessionId: "sess-1",
    });

    expect(result).toMatchObject({ success: true, orderItemId: 500, taskId: 121, status: "blocked" });
    expect(replenishment.recordSourceEmptyBlocker).toHaveBeenCalledWith(expect.objectContaining({
      pickVariantId: 100,
      pickLocationId: 1,
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      sku: "SKU-1",
      sourceLocationCode: "B-01",
      userId: "picker-1",
    }));
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "replen_source_empty_reported",
      orderItemId: 500,
      locationCode: "A-01",
      reason: "source_empty",
      itemStatusBefore: "pending",
      itemStatusAfter: "pending",
    }));
  });
});

describe("PickingUseCases post-pick replen context", () => {
  it("queues replen after a confirmed short pick without deducting inventory", async () => {
    const pickLocation = { id: 1, code: "A-01", warehouseId: 1, isPickable: 1 };
    const beforeItem = makeItem({ status: "pending", pickedQuantity: 0, quantity: 2 });
    const updatedItem = {
      ...beforeItem,
      status: "short",
      pickedQuantity: 0,
      shortReason: "out_of_stock",
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn(async () => [pickLocation]),
          }),
        }),
      })),
    };
    const inventoryCore = {
      pickItem: vi.fn(),
      adjustInventory: vi.fn(),
    };
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      updateOrderItemStatus: vi.fn(async () => updatedItem),
      getProductVariantBySku: vi.fn(async (sku: string) => ({
        id: 100,
        sku,
        productId: 10,
        unitsPerVariant: 1,
      })),
      getOrderById: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseId: 1,
        assignedPickerId: "picker-1",
      })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
      getAllWarehouseSettings: vi.fn(async () => [{
        warehouseId: 1,
        postPickStatus: "completed",
        pickMode: "single_order",
        requireScanConfirm: 0,
      }]),
      updateOrderProgress: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "completed",
      })),
    };
    const replenishment = {
      ensureQueuedReplenForShortPick: vi.fn(async () => ({
        task: { id: 300, status: "pending", qtyTargetUnits: 4 },
        moved: 0,
        guidance: {
          sourceLocationCode: "B-01",
          sourceVariantSku: "SKU-1",
          sourceVariantName: "Each",
          qtyTargetUnits: 4,
        },
      })),
    };
    const service = new PickingUseCases(db as any, inventoryCore as any, replenishment as any, storage as any);

    const result = await service.pickItem(500, {
      status: "short",
      pickedQuantity: 0,
      shortReason: "out_of_stock",
      pickMethod: "short",
      userId: "picker-1",
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("pickItem should have succeeded");
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
    expect(replenishment.ensureQueuedReplenForShortPick).toHaveBeenCalledWith(100, 1, "picker-1", expect.objectContaining({
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      blocksShipment: false,
    }));
    expect(result.inventory.replen).toMatchObject({
      triggered: true,
      taskId: 300,
      taskStatus: "pending",
      autoExecuted: false,
      autoExecutedMoved: null,
      autoExecutedFailed: false,
      sourceLocationCode: "B-01",
      qtyToMove: 4,
    });
  });

  it("reports queued replen without inline movement confirmation fields", async () => {
    const { service, replenishment } = makePickItemHarness({
      task: { id: 121, status: "pending", qtyTargetUnits: 6 },
      moved: 0,
    });

    const result = await service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("pickItem should have succeeded");
    expect(result.inventory.replen).toMatchObject({
      triggered: true,
      taskId: 121,
      taskStatus: "pending",
      autoExecuted: false,
      autoExecutedMoved: null,
      autoExecutedFailed: false,
      qtyToMove: 6,
    });
    expect(replenishment.createAndExecuteReplen).toHaveBeenCalledWith(100, 1, "picker-1", expect.objectContaining({
      orderId: 900,
      orderItemId: 500,
      blocksShipment: false,
    }));
  });

  it("reports completed inline replen movement for picker verification", async () => {
    const { service } = makePickItemHarness({
      task: { id: 122, status: "completed", qtyTargetUnits: 8 },
      moved: 8,
    });

    const result = await service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("pickItem should have succeeded");
    expect(result.inventory.replen).toMatchObject({
      triggered: true,
      taskId: 122,
      taskStatus: "completed",
      autoExecuted: true,
      autoExecutedMoved: 8,
      autoExecutedMovedBaseUnits: 8,
      autoExecutedMovedUom: "units",
      qtyToMove: 8,
    });
  });

  it("reports case-break inline replen movement in pick-bin units for picker verification", async () => {
    const { service, storage } = makePickItemHarness({
      task: {
        id: 123,
        status: "completed",
        replenMethod: "case_break",
        sourceProductVariantId: 200,
        pickProductVariantId: 100,
        qtySourceUnits: 1,
        qtyTargetUnits: 1000,
      },
      moved: 1000,
    });
    storage.getProductVariantById.mockImplementation(async (id: number) => {
      if (id === 100) {
        return {
          id,
          sku: "ARM-ENV-SGL-P25",
          name: "Pack of 25",
          productId: 10,
          unitsPerVariant: 25,
          hierarchyLevel: 1,
        };
      }

      return {
        id,
        sku: "ARM-ENV-SGL-C1000",
        name: "Case of 1000",
        productId: 10,
        unitsPerVariant: 1000,
        hierarchyLevel: 3,
      };
    });

    const result = await service.pickItem(500, {
      status: "completed",
      pickedQuantity: 1,
      pickMethod: "scan",
      userId: "picker-1",
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("pickItem should have succeeded");
    expect(result.inventory.replen).toMatchObject({
      triggered: true,
      taskId: 123,
      taskStatus: "completed",
      autoExecuted: true,
      autoExecutedMoved: 40,
      autoExecutedMovedBaseUnits: 1000,
      autoExecutedMovedUom: "packs",
      qtyToMove: 40,
    });
  });
});

describe("PickingUseCases pick queue replen prediction", () => {
  it("uses the fresh pick bin and shared replen prediction resolver", async () => {
    const storage = {
      getAllWarehouseLocations: vi.fn(async () => [
        { id: 1, code: "A-01", locationType: "pick", isPickable: 1 },
        { id: 2, code: "OLD-01", locationType: "pick", isPickable: 1 },
      ]),
      getProductVariantBySku: vi.fn(async (sku: string) => ({
        id: 100,
        sku,
        productId: 10,
        unitsPerVariant: 1,
      })),
    };
    const replenishment = {
      predictReplenAfterPick: vi.fn(async () => ({
        systemQty: 5,
        postPickQty: 2,
        triggerValue: 3,
        replenNeeded: true,
        replenMethod: "case_break",
        autoReplen: 1,
        stockout: false,
        executionMode: "inline",
        sourceLocationCode: "B-01",
        sourceQty: 12,
        sourceVariantName: "Case",
      })),
    };
    const service = new PickingUseCases({} as any, {} as any, replenishment as any, storage as any);

    const predictions = await (service as any)._buildReplenPredictions(
      [{ id: 501, sku: "SKU-1", quantity: 3, location: "OLD-01" }],
      new Map([[
        "SKU-1",
        { location: "A-01", zone: "A", barcode: null, imageUrl: null },
      ]]),
    );

    expect(replenishment.predictReplenAfterPick).toHaveBeenCalledWith(100, 1, 3);
    expect(predictions.get(501)).toMatchObject({
      replenNeeded: true,
      replenMethod: "case_break",
      sourceLocationCode: "B-01",
      sourceQty: 12,
    });
  });
});

describe("PickingUseCases bin count replen feedback", () => {
  it("does not create replen work from picker bin-count input", async () => {
    const { service } = makeService([
      { warehouseLocationId: 1, variantQty: 5 },
    ]);
    const createAndExecuteReplen = vi.fn();
    (service as any).replenishment = { createAndExecuteReplen };

    const result = await service.handleBinCount({
      sku: "SKU-1",
      locationId: 1,
      binCount: 5,
      didReplen: true,
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      replenTriggered: false,
      replenTaskStatus: null,
      replenFailReason: null,
    });
    expect(createAndExecuteReplen).not.toHaveBeenCalled();
  });

  it("does not cancel existing replen work from picker bin-count input", async () => {
    const { service, storage } = makeService([
      { warehouseLocationId: 1, variantQty: 5 },
    ]);
    storage.getPendingReplenTasksForLocation.mockResolvedValue([{
      id: 121,
      pickProductVariantId: 100,
      status: "pending",
    }]);

    const result = await service.handleBinCount({
      sku: "SKU-1",
      locationId: 1,
      binCount: 5,
      didReplen: false,
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      replenTriggered: false,
      replenTaskStatus: null,
      replenFailReason: null,
    });
    expect(storage.updateReplenTask).not.toHaveBeenCalled();
  });
});

describe("PickingUseCases allocation blocker idempotency", () => {
  const blockerInput = {
    item: makeItem({ id: 501, orderId: 901, sku: "SKU-BLOCK" }),
    order: { id: 901, orderNumber: "#901" },
    productVariantId: 100,
    exceptionType: "inventory_deduction_failed",
    requestedQty: 3,
    selectedLocationId: 1,
    selectedLocationCode: "A-01",
    reviewReason: "Bin A-01 has 0 for SKU-BLOCK, but 3 is needed",
    metadata: {
      pickerNonBlocking: true,
      systemQty: 0,
    },
  };

  it("reuses an exact open shipment blocker instead of inserting a duplicate", async () => {
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 71, metadata: { firstSeen: true } }] })
        .mockResolvedValueOnce({ rows: [{ id: 71, metadata: { firstSeen: true, shipmentBlocking: true } }] }),
      insert: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (callback: (txArg: any) => Promise<any>) => callback(tx)),
      execute: vi.fn(),
    };
    const service = new PickingUseCases(db as any, {} as any, {} as any, {} as any);

    await expect((service as any).createBlockingAllocationException(blockerInput)).resolves.toMatchObject({
      created: false,
      exception: { id: 71 },
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("supersedes older open blockers before inserting the current blocker", async () => {
    const returning = vi.fn(async () => [{ id: 72 }]);
    const values = vi.fn(() => ({ returning }));
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 70 }] }),
      insert: vi.fn(() => ({ values })),
    };
    const db = {
      transaction: vi.fn(async (callback: (txArg: any) => Promise<any>) => callback(tx)),
      execute: vi.fn(),
    };
    const service = new PickingUseCases(db as any, {} as any, {} as any, {} as any);

    await expect((service as any).createBlockingAllocationException(blockerInput)).resolves.toMatchObject({
      created: true,
      exception: { id: 72 },
    });
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId: 501,
      status: "blocked",
      metadata: expect.objectContaining({ shipmentBlocking: true }),
    }));
  });

  it("casts nullable blocker lookup parameters so Postgres can infer types", async () => {
    const returning = vi.fn(async () => [{ id: 73 }]);
    const values = vi.fn(() => ({ returning }));
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      insert: vi.fn(() => ({ values })),
    };
    const db = {
      transaction: vi.fn(async (callback: (txArg: any) => Promise<any>) => callback(tx)),
      execute: vi.fn(),
    };
    const service = new PickingUseCases(db as any, {} as any, {} as any, {} as any);

    await expect((service as any).createBlockingAllocationException({
      ...blockerInput,
      selectedLocationId: null,
      selectedLocationCode: null,
    })).resolves.toMatchObject({
      created: true,
      exception: { id: 73 },
    });

    const exactLookupSql = (tx.execute.mock.calls[0]?.[0]?.queryChunks ?? [])
      .flatMap((chunk: any) => Array.isArray(chunk?.value) ? chunk.value : [])
      .join("");
    expect(exactLookupSql).toContain("COALESCE(selected_location_id, -1) = COALESCE(");
    expect(exactLookupSql).toContain("::integer, -1)");
    expect(exactLookupSql).toContain("COALESCE(selected_location_code, '') = COALESCE(");
    expect(exactLookupSql).toContain("::text, '')");
    expect(exactLookupSql).toContain("COALESCE(review_reason, '') = ");
    expect(exactLookupSql).toContain("::text");
  });
});

describe("PickingUseCases shipment blocker cleanup", () => {
  it("keeps shipment blockers open when the exception is held", async () => {
    const db = {
      execute: vi.fn(),
    };
    const service = new PickingUseCases(db as any, {} as any, {} as any, {} as any);

    await expect(service.closeResolvedShipmentBlockers(900, {
      resolution: "hold",
      userId: "lead-1",
    })).resolves.toEqual({
      allocationExceptionsClosed: 0,
      replenTasksClosed: 0,
    });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("closes order shipment blockers for non-hold exception resolutions", async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 77 }] })
        .mockResolvedValueOnce({ rows: [{ id: 121 }, { id: 122 }] }),
    };
    const service = new PickingUseCases(db as any, {} as any, {} as any, {} as any);

    await expect(service.closeResolvedShipmentBlockers(900, {
      resolution: "resolved",
      userId: "lead-1",
      notes: "Inventory corrected",
    })).resolves.toEqual({
      allocationExceptionsClosed: 1,
      replenTasksClosed: 2,
    });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});
