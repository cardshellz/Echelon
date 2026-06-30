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
  items?: any[];
}) {
  const storage = {
    getOrderById: vi.fn(async () => opts.currentOrder),
    claimOrder: vi.fn(async () => opts.claimResult),
    getUser: vi.fn(async () => opts.holder ?? null),
    createPickingLog: vi.fn(async () => ({})),
    getOrderItems: vi.fn(async () => opts.items ?? []),
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
    const claimed = { id: 1, orderNumber: "58054", warehouseStatus: "in_progress", assignedPickerId: "me" };
    const { service } = makeService({ claimResult: claimed, currentOrder: claimed });
    const result = await service.claimOrder(1, "me");
    expect(result.order).toEqual(claimed);
  });

  it("rejects generic claims for ready orders with preserved pick progress", async () => {
    const { service, storage } = makeService({
      claimResult: { id: 1, orderNumber: "59542", warehouseStatus: "in_progress", assignedPickerId: "me" },
      currentOrder: { id: 1, orderNumber: "59542", warehouseStatus: "ready", onHold: 0, assignedPickerId: null },
      items: [
        { id: 11, quantity: 1, pickedQuantity: 1, status: "completed" },
        { id: 12, quantity: 4, pickedQuantity: 0, status: "pending" },
      ],
    });

    await expect(service.claimOrder(1, "me")).rejects.toMatchObject({
      context: {
        reason: "preserved_progress_requires_resume",
        orderId: 1,
        claimSource: null,
        pickedUnits: 1,
        progressLines: 1,
      },
      statusCode: 409,
    });
    expect(storage.claimOrder).not.toHaveBeenCalled();
  });

  it("allows explicit preserved-progress resume claims", async () => {
    const claimed = { id: 1, orderNumber: "59542", warehouseStatus: "in_progress", assignedPickerId: "me" };
    const { service, storage } = makeService({
      claimResult: claimed,
      currentOrder: { id: 1, orderNumber: "59542", warehouseStatus: "ready", onHold: 0, assignedPickerId: null },
      items: [
        { id: 11, quantity: 1, pickedQuantity: 1, status: "completed" },
        { id: 12, quantity: 4, pickedQuantity: 0, status: "pending" },
      ],
    });

    const result = await service.claimOrder(
      1,
      "me",
      "desktop",
      "session-1",
      "preserved_progress_resume",
    );

    expect(result.order).toEqual(claimed);
    expect(storage.claimOrder).toHaveBeenCalledWith(1, "me");
    expect(storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { claimSource: "preserved_progress_resume" },
      orderStatusBefore: "ready",
      orderStatusAfter: "in_progress",
    }));
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
