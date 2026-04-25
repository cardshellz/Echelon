/**
 * C16 — recomputeOrderStatusFromShipments is the only writer of
 * shipment-derived warehouse_status.
 *
 * Pins the invariant for:
 *   - orders.storage.ts::updateOrderStatus
 *
 * Exhaustive rollup coverage lives in shipment-rollup.test.ts (33 cases).
 * Here we only verify the delegation happens for shipment-derived
 * statuses and the direct-write path is preserved for ops statuses.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 16.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock recomputeOrderStatusFromShipments so we can observe whether the
// storage function invokes it. vi.mock is hoisted; factory closes over
// no outer variables.
vi.mock("../../shipment-rollup", () => ({
  recomputeOrderStatusFromShipments: vi.fn(),
}));

// Mock the db module the storage file imports. Using `doMock` inside
// the factory would also work; here we rely on the fact that the
// factory evaluates at mock-time (no outer-scope access).
vi.mock("../../../../db", () => {
  const fakeDb = {
    update: vi.fn(),
    select: vi.fn(),
    execute: vi.fn(),
  };
  return { db: fakeDb };
});

import { db as mockedDb } from "../../../../db";
import { recomputeOrderStatusFromShipments } from "../../shipment-rollup";
import { orderMethods as ordersStorage } from "../../orders.storage";

const recomputeMock = recomputeOrderStatusFromShipments as unknown as ReturnType<
  typeof vi.fn
>;
const dbMock = mockedDb as unknown as {
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
};

// Helper that builds a chainable db.update(...).set(...).where(...).returning() stub.
function mockUpdateChain(returningValue: any[]) {
  const returning = vi.fn().mockResolvedValue(returningValue);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  dbMock.update.mockReturnValue({ set });
  return { set, where, returning };
}

// Helper that builds db.select().from().where().limit() stub.
function mockSelectChain(resolved: any[]) {
  const limit = vi.fn().mockResolvedValue(resolved);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  dbMock.select.mockReturnValue({ from });
  return { from, where, limit };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.execute.mockResolvedValue({ rows: [] });
  // Default select/update chain returns reasonable values
  mockUpdateChain([{ id: 42, warehouseStatus: "ready" }]);
  mockSelectChain([{ id: 42, warehouseStatus: "shipped" }]);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("updateOrderStatus — shipment-derived delegation (C16)", () => {
  it("delegates to recompute when status is 'shipped'", async () => {
    recomputeMock.mockResolvedValue({ warehouseStatus: "shipped", changed: true });

    await ordersStorage.updateOrderStatus(42, "shipped" as any);

    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock).toHaveBeenCalledWith(dbMock, 42);

    // No direct .update() write on the shipment-derived path
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("delegates to recompute when status is 'partially_shipped'", async () => {
    recomputeMock.mockResolvedValue({
      warehouseStatus: "partially_shipped",
      changed: true,
    });

    await ordersStorage.updateOrderStatus(42, "partially_shipped" as any);

    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("logs a warning when recompute returns a different state than requested", async () => {
    recomputeMock.mockResolvedValue({
      warehouseStatus: "partially_shipped",
      changed: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ordersStorage.updateOrderStatus(42, "shipped" as any);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("partially_shipped");
    warnSpy.mockRestore();
  });

  it("does NOT log a warning when recompute matches the request", async () => {
    recomputeMock.mockResolvedValue({ warehouseStatus: "shipped", changed: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ordersStorage.updateOrderStatus(42, "shipped" as any);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("takes the direct-write path for 'ready' (ops state)", async () => {
    await ordersStorage.updateOrderStatus(42, "ready" as any);

    expect(recomputeMock).not.toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("takes the direct-write path for 'cancelled' (operator intent)", async () => {
    await ordersStorage.updateOrderStatus(42, "cancelled" as any);

    expect(recomputeMock).not.toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("takes the direct-write path for 'packing' (ops state)", async () => {
    await ordersStorage.updateOrderStatus(42, "packing" as any);

    expect(recomputeMock).not.toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("cascades item completion via db.execute when recompute yields 'shipped'", async () => {
    recomputeMock.mockResolvedValue({ warehouseStatus: "shipped", changed: true });

    await ordersStorage.updateOrderStatus(42, "shipped" as any);

    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it("does NOT cascade item completion when recompute yields a non-shipped state", async () => {
    recomputeMock.mockResolvedValue({ warehouseStatus: "ready", changed: false });

    await ordersStorage.updateOrderStatus(42, "shipped" as any);

    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});
