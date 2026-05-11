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
    const db = {
      execute: vi.fn(async () => ({
        rows: [{
          id: 77,
          sku: "SKU-1",
          exception_type: "inventory_deduction_failed",
          status: "blocked",
          review_reason: "System inventory did not match picker observation",
        }],
      })),
    };
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
    const db = {
      execute: vi.fn(async () => ({ rows: [] })),
    };
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
    const db = {
      execute: vi.fn(async () => ({
        rows: [{
          id: 88,
          sku: "SKU-1",
          exception_type: "inventory_deduction_failed",
          status: "blocked",
          review_reason: "Inventory deduction failed",
        }],
      })),
    };
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
});
