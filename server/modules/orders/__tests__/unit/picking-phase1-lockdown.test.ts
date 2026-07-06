import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    orderId: 900,
    sku: "SKU-1",
    name: "Test SKU",
    quantity: 2,
    pickedQuantity: 0,
    requiresShipping: 1,
    location: "A-01",
    status: "pending",
    shortReason: null,
    ...overrides,
  } as any;
}

describe("picking phase 1 mutation lockdown", () => {
  it("releases orders with progress preserved by default", async () => {
    const orderBefore = {
      id: 900,
      orderNumber: "#900",
      warehouseStatus: "in_progress",
      assignedPickerId: "picker-1",
    };
    const releasedOrder = {
      ...orderBefore,
      warehouseStatus: "ready",
      assignedPickerId: null,
    };
    const storage = {
      getOrderById: vi.fn(async () => orderBefore),
      releaseOrder: vi.fn(async () => releasedOrder),
      getUser: vi.fn(async () => ({ id: "admin-1", username: "admin", role: "admin" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases({} as any, {} as any, {} as any, storage as any);

    await expect(service.releaseOrder(900, { userId: "admin-1" })).resolves.toEqual(releasedOrder);

    expect(storage.releaseOrder).toHaveBeenCalledWith(900, false);
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "order_released",
      pickerId: "admin-1",
      reason: "Progress preserved",
    }));
  });

  it("rejects picker release attempts that request progress reset", async () => {
    const storage = {
      getOrderById: vi.fn(),
      releaseOrder: vi.fn(),
      getUser: vi.fn(),
      createPickingLog: vi.fn(),
    };
    const service = new PickingUseCases({} as any, {} as any, {} as any, storage as any);

    await expect(service.releaseOrder(900, { resetProgress: true })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(storage.releaseOrder).not.toHaveBeenCalled();
  });

  it("rejects active item picks on held orders before changing item state", async () => {
    const beforeItem = makeItem({ status: "pending", pickedQuantity: 0, quantity: 1 });
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      getOrderById: vi.fn(async () => ({
        id: beforeItem.orderId,
        orderNumber: "#900",
        warehouseStatus: "ready",
        warehouseId: 1,
        assignedPickerId: "picker-1",
        onHold: 1,
      })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      updateOrderItemStatus: vi.fn(),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases({} as any, {} as any, {} as any, storage as any);

    const result = await service.pickItem(beforeItem.id, {
      status: "completed",
      pickedQuantity: 1,
      pickMethod: "manual",
      userId: "picker-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: "order_on_hold",
    });
    expect(storage.updateOrderItemStatus).not.toHaveBeenCalled();
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "pick_command_rejected",
      reason: "order_on_hold",
      orderItemId: beforeItem.id,
    }));
  });

  it("unpicks completed items by reversing picked inventory and demoting order progress atomically", async () => {
    const beforeItem = makeItem({ status: "completed", pickedQuantity: 2, quantity: 2 });
    const updatedItem = { ...beforeItem, status: "in_progress", pickedQuantity: 1 };
    const updateCalls: Array<Record<string, any>> = [];
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ warehouse_status: "in_progress", on_hold: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: beforeItem.id, status: "completed", picked_quantity: 2, quantity: 2 }] }),
      update: vi.fn(() => ({
        set: vi.fn((updates: Record<string, any>) => {
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
      transaction: vi.fn(async (callback: (txArg: any) => Promise<any>) => callback(tx)),
    };
    const inventoryCore: any = {
      withTx: vi.fn(() => inventoryCore),
      unpickItem: vi.fn(async () => true),
    };
    const storage = {
      getOrderItemById: vi.fn(async () => beforeItem),
      getOrderById: vi.fn(async () => ({
        id: beforeItem.orderId,
        orderNumber: "#900",
        warehouseStatus: "in_progress",
        assignedPickerId: "picker-1",
        onHold: 0,
      })),
      getProductVariantBySku: vi.fn(async () => ({ id: 100, sku: beforeItem.sku })),
      getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "A-01" }]),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker", role: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
    };
    const service = new PickingUseCases(db as any, inventoryCore as any, {} as any, storage as any);

    const result = await service.unpickItem(beforeItem.id, {
      qty: 1,
      userId: "picker-1",
      reason: "test unpick",
    });

    expect(result).toMatchObject({
      success: true,
      item: expect.objectContaining({ id: beforeItem.id, pickedQuantity: 1, status: "in_progress" }),
    });
    expect(inventoryCore.unpickItem).toHaveBeenCalledWith(expect.objectContaining({
      productVariantId: 100,
      warehouseLocationId: 1,
      qty: 1,
      orderId: beforeItem.orderId,
      orderItemId: beforeItem.id,
    }));
    expect(updateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ pickedQuantity: 1, status: "in_progress" }),
      expect.objectContaining({ pickedCount: 1, warehouseStatus: "in_progress", completedAt: null }),
    ]));
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "item_unpicked",
      qtyBefore: 2,
      qtyAfter: 1,
      qtyDelta: -1,
      reason: "test unpick",
    }));
  });
});
