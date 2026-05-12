import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

function makeService(levels: Array<{ warehouseLocationId: number; variantQty: number }>) {
  const locations = [
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

  const service = new PickingUseCases({} as any, inventoryCore as any, {} as any, storage as any);
  return { service, storage, inventoryCore };
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

  it("does not auto-correct a shortage for manual or button picks", async () => {
    const { service, inventoryCore } = makeService([
      { warehouseLocationId: 1, variantQty: 0 },
      { warehouseLocationId: 2, variantQty: 10 },
    ]);

    const result = await (service as any)._deductInventory(makeItem(), makeItem(), {
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: "insufficient_inventory",
      locationId: 1,
      pickerBlocking: false,
      shipmentBlocking: true,
    });
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
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
      qtyToMove: 8,
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
  it("reports queued replen as pending instead of completed", async () => {
    const { service } = makeService([
      { warehouseLocationId: 1, variantQty: 5 },
    ]);
    (service as any).replenishment = {
      createAndExecuteReplen: vi.fn(async () => ({
        task: { id: 121, status: "pending" },
        moved: 0,
      })),
    };

    const result = await service.handleBinCount({
      sku: "SKU-1",
      locationId: 1,
      binCount: 5,
      didReplen: true,
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      replenTriggered: true,
      replenTaskStatus: "pending",
      replenFailReason: null,
    });
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
