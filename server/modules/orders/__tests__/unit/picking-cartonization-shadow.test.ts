import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../picking.use-cases";
const progressOwner = vi.hoisted(() => vi.fn());
vi.mock("../../../wms/picking-progress.repository", () => ({reconcileWmsPickingProgress:progressOwner}));

function buildService(
  planResult: { complete: boolean } | null | Promise<{ complete: boolean } | null>,
  shadowEnabled = true,
) {
  const ensurePackPlan = vi.fn(async () => planResult);
  const db = {
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: async (work: (tx: object) => Promise<unknown>) => work({}),
  };
  const order = {
    id: 42,
    orderNumber: "WMS-42",
    assignedPickerId: null,
    warehouseStatus: "in_progress",
  };
  progressOwner.mockReset().mockImplementation(async (_tx, _id, status) => ({...order,warehouseStatus:status}));
  const storage = {
    getOrderById: vi.fn(async () => order),
    getOrderItems: vi.fn(async () => [{
      id: 7,
      orderId: 42,
      sku: "SKU-1",
      name: "Physical item",
      quantity: 1,
      pickedQuantity: 1,
      requiresShipping: 1,
      onHold: false,
      status: "completed",
      location: "A-01",
    }]),
    updateOrderStatus: vi.fn(async () => ({
      ...order,
      warehouseStatus: "ready_to_ship",
    })),
    getUser: vi.fn(async () => null),
    createPickingLog: vi.fn(async () => ({})),
  };

  const service = new PickingUseCases(
    db as any,
    {} as any,
    {} as any,
    storage as any,
    undefined,
    { ensurePackPlan },
    shadowEnabled,
  );

  return { service, storage, ensurePackPlan };
}

describe("WMS cartonization shadow", () => {
  it("records a verified plan without changing ready_to_ship", async () => {
    const { service, storage, ensurePackPlan } = buildService({ complete: true });

    const result = await service.markReadyToShip(42, "picker-1");

    expect(result?.warehouseStatus).toBe("ready_to_ship");
    expect(ensurePackPlan).toHaveBeenCalledWith({ wmsOrderId: 42 });
    expect(progressOwner).toHaveBeenCalledWith({},42,"ready_to_ship","picker-1",expect.any(Function));
  });

  it("does not block manual handoff when no verified plan can be produced", async () => {
    const { service, storage, ensurePackPlan } = buildService(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await service.markReadyToShip(42, "picker-1");

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
    expect(result?.warehouseStatus).toBe("ready_to_ship");
    expect(ensurePackPlan).toHaveBeenCalledWith({ wmsOrderId: 42 });
    expect(progressOwner).toHaveBeenCalledOnce();
  });

  it("does not write order progress when automatic cartonization fails", async () => {
      const { service, storage } = buildService(null);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      (service as any).triggerCartonizationShadow(42);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(progressOwner).not.toHaveBeenCalled();
      expect(storage.updateOrderStatus).not.toHaveBeenCalled();
      warn.mockRestore();
  });

  it("does not execute automatically while the shadow flag is off", async () => {
    const { service, ensurePackPlan } = buildService({ complete: true }, false);

    await service.markReadyToShip(42, "picker-1");

    expect(ensurePackPlan).not.toHaveBeenCalled();
  });

  it("does not wait for a stalled shadow plan", async () => {
    const stalledPlan = new Promise<{ complete: boolean } | null>(() => {});
    const { service, storage, ensurePackPlan } = buildService(stalledPlan);

    const result = await service.markReadyToShip(42, "picker-1");

    expect(result?.warehouseStatus).toBe("ready_to_ship");
    expect(ensurePackPlan).toHaveBeenCalledWith({ wmsOrderId: 42 });
    expect(progressOwner).toHaveBeenCalledOnce();
  });
});
