import { describe, expect, it, vi } from "vitest";

import { createReservationService } from "../../reservation.service";

describe("ReservationService recipe-managed promise routing", () => {
  it("delegates recipe-managed lines without reading physical ATP", async () => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ productId: 5, requiresShipping: true, trackInventory: true }],
          }),
        }),
      })),
    };
    const db = { transaction: vi.fn(async (work: any) => work(tx)) };
    const inventoryCore = { reserveForOrder: vi.fn() };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn() };
    const atp = {
      getAtpPerVariant: vi.fn(),
      getProductInventoryStrategy: vi.fn(async () => "recipe_managed" as const),
    };
    const recipePromise = {
      claimOrderItem: vi.fn(async () => ({ reserved: 0, promised: 4, shortfall: 0 })),
      cancelOrderDemands: vi.fn(),
    };
    const service = createReservationService(
      db as any,
      inventoryCore,
      channelSync,
      atp,
      recipePromise,
    );

    const result = await service.reserveForOrder(5, 50, 4, 500, 600, "test-user");

    expect(result).toEqual({ reserved: 0, promised: 4, shortfall: 0 });
    expect(recipePromise.claimOrderItem).toHaveBeenCalledWith({
      productId: 5,
      variantId: 50,
      orderQty: 4,
      orderId: 500,
      orderItemId: 600,
      actorId: "test-user",
    }, tx);
    expect(atp.getAtpPerVariant).not.toHaveBeenCalled();
    expect(inventoryCore.reserveForOrder).not.toHaveBeenCalled();
  });

  it("treats a direct digital reservation call as not applicable", async () => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ productId: 5, requiresShipping: false, trackInventory: false }],
          }),
        }),
      })),
    };
    const db = { transaction: vi.fn(async (work: any) => work(tx)) };
    const inventoryCore = { reserveForOrder: vi.fn() };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn() };
    const atp = {
      getAtpPerVariant: vi.fn(),
      getProductInventoryStrategy: vi.fn(),
    };
    const recipePromise = {
      claimOrderItem: vi.fn(),
      cancelOrderDemands: vi.fn(),
    };
    const service = createReservationService(
      db as any,
      inventoryCore,
      channelSync,
      atp,
      recipePromise,
    );

    await expect(service.reserveForOrder(5, 50, 4, 500, 600, "test-user"))
      .resolves.toEqual({ reserved: 0, promised: 0, shortfall: 0 });
    expect(atp.getProductInventoryStrategy).not.toHaveBeenCalled();
    expect(recipePromise.claimOrderItem).not.toHaveBeenCalled();
    expect(inventoryCore.reserveForOrder).not.toHaveBeenCalled();
  });

  it("rejects an internal-only customer promise before ATP or recipe planning", async () => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              productId: 5,
              requiresShipping: true,
              trackInventory: true,
              salesEligibility: "internal_only",
            }],
          }),
        }),
      })),
    };
    const db = { transaction: vi.fn(async (work: any) => work(tx)) };
    const inventoryCore = { reserveForOrder: vi.fn() };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn() };
    const atp = {
      getAtpPerVariant: vi.fn(),
      getProductInventoryStrategy: vi.fn(),
    };
    const recipePromise = {
      claimOrderItem: vi.fn(),
      cancelOrderDemands: vi.fn(),
    };
    const service = createReservationService(
      db as any,
      inventoryCore,
      channelSync,
      atp,
      recipePromise,
    );

    await expect(service.reserveForOrder(5, 50, 4, 500, 600, "test-user"))
      .resolves.toEqual({ reserved: 0, promised: 0, shortfall: 4 });
    expect(atp.getProductInventoryStrategy).not.toHaveBeenCalled();
    expect(recipePromise.claimOrderItem).not.toHaveBeenCalled();
    expect(inventoryCore.reserveForOrder).not.toHaveBeenCalled();
  });
});
