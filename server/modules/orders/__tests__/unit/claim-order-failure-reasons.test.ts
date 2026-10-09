import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";

/**
 * Behavioral coverage for claimOrder failure classification.
 *
 * When the guarded UPDATE in storage.claimOrder rejects a claim (returns null),
 * the use-case must tell the picker the REAL reason instead of always blaming
 * "another picker". These tests drive each branch.
 */
function makeService(opts: {
  claimResult: any;
  currentOrder: any;
  holder?: any;
}) {
  const storage = {
    getOrderById: vi.fn(async () => opts.currentOrder),
    claimOrder: vi.fn(async () => opts.claimResult),
    getUser: vi.fn(async () => opts.holder ?? null),
    createPickingLog: vi.fn(async () => ({})),
    getOrderItems: vi.fn(async () => []),
  };
  const service = new PickingUseCases(
    {} as any,
    {} as any,
    {} as any,
    storage as any,
  );
  return { service, storage };
}

describe("claimOrder failure reasons", () => {
  it("succeeds and returns order + items when claim is granted", async () => {
    const claimed = { id: 1, orderNumber: "58054", warehouseStatus: "in_progress", assignedPickerId: "me",
      warehouseId: 1, onHold: 0, startedAt: new Date("2026-10-04T12:00:00Z") };
    const { service } = makeService({ claimResult: claimed, currentOrder: claimed });
    const result = await service.claimOrder(1, "me");
    expect(result.order).toEqual(claimed);
  });

  it("returns only shipping lines, so digital items never reach the gun (#64031)", async () => {
    const claimed = { id: 1, orderNumber: "64031", warehouseStatus: "in_progress", assignedPickerId: "me",
      warehouseId: 1, onHold: 0, startedAt: new Date("2026-10-08T12:00:00Z") };
    const { service, storage } = makeService({ claimResult: claimed, currentOrder: claimed });
    storage.getOrderItems.mockResolvedValue([{ id: 323569, orderId: 1, sku: "CLUB-ANNUAL-US", quantity: 1,
      pickedQuantity: 0, fulfilledQuantity: 0, status: "completed", requiresShipping: 0,
      inventoryTracking: false, catalogProductId: 316, productId: 465 }] as any);
    const result = await service.claimOrder(1, "me");
    expect(result.items).toEqual([]);
  });

  it("throws not_found when the order does not exist", async () => {
    const { service } = makeService({ claimResult: null, currentOrder: null });
    await expect(service.claimOrder(999, "me")).rejects.toMatchObject({
      context: { reason: "not_found" },
      statusCode: 404,
    });
  });

  it("throws on_hold when the order is held", async () => {
    const { service } = makeService({
      claimResult: null,
      currentOrder: { id: 1, warehouseStatus: "ready", onHold: 1, assignedPickerId: null },
    });
    await expect(service.claimOrder(1, "me")).rejects.toMatchObject({
      context: { reason: "on_hold" },
      statusCode: 409,
    });
  });

  it("throws in_progress_other (with picker name) when actively picked by someone else", async () => {
    const { service } = makeService({
      claimResult: null,
      currentOrder: { id: 1, warehouseStatus: "in_progress", onHold: 0, assignedPickerId: "picker_a" },
      holder: { displayName: "Alice" },
    });
    await expect(service.claimOrder(1, "me")).rejects.toMatchObject({
      context: { reason: "in_progress_other", pickerName: "Alice" },
      statusCode: 409,
    });
  });

  it("throws not_claimable for terminal/other states (stale picker no longer blamed on another picker)", async () => {
    const { service } = makeService({
      claimResult: null,
      // ready_to_ship with a stale picker id from a prior pass — this used to be
      // reported as "claimed by another picker". The guarded UPDATE should
      // normally accept this now, but if it is rejected for any other reason the
      // message must reflect the real status, not blame a phantom picker.
      currentOrder: { id: 1, warehouseStatus: "shipped", onHold: 0, assignedPickerId: "picker_a" },
    });
    await expect(service.claimOrder(1, "me")).rejects.toMatchObject({
      context: { reason: "not_claimable", warehouseStatus: "shipped" },
      statusCode: 409,
    });
  });
});
