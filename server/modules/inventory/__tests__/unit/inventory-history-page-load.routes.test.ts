import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const reads = vi.hoisted(() => ({
  getInventoryTransactions: vi.fn(), getWarehouseLocationsByIds: vi.fn(),
  getProductVariantsByIds: vi.fn(), getOrderById: vi.fn(),
  getAllWarehouseLocations: vi.fn(), getAllProductVariants: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../index", () => ({ inventoryStorage: reads }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { requirePermission: () => pass, requireAuth: pass, upload: { single: () => pass } };
});
import { registerInventoryRoutes } from "../../inventory.routes";

describe("inventory history bounded HTTP loading", () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    reads.getInventoryTransactions.mockResolvedValue([]);
    const app = express();
    registerInventoryRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory/transactions`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it("hydrates only the current page's locations and variants", async () => {
    reads.getInventoryTransactions.mockResolvedValue([{ id: 1, fromLocationId: 8, toLocationId: 9, productVariantId: 17, orderId: 42 }]);
    reads.getWarehouseLocationsByIds.mockResolvedValue([{ id: 8, code: "A-1" }, { id: 9, code: "B-1" }]);
    reads.getProductVariantsByIds.mockResolvedValue([{ id: 17, sku: "SLEEVE" }]);
    reads.getOrderById.mockResolvedValue({ id: 42, orderNumber: "TEST-42" });
    const response = await fetch(url + "?limit=100&offset=200");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ fromLocation: { id: 8 }, toLocation: { id: 9 }, product: { id: 17 }, order: { id: 42 } }]);
    expect(reads.getInventoryTransactions).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, offset: 200 }));
    expect(reads.getWarehouseLocationsByIds).toHaveBeenCalledExactlyOnceWith([8, 9]);
    expect(reads.getProductVariantsByIds).toHaveBeenCalledExactlyOnceWith([17]);
    expect(reads.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(reads.getAllProductVariants).not.toHaveBeenCalled();
  });

  it.each(["limit=1000000", "limit=-1", "limit=2.5", "limit=50junk", "limit=50&limit=50", "offset=-1", "offset=2147483648"])("rejects unsafe query %s before database work", async query => {
    expect((await fetch(url + "?" + query)).status).toBe(400);
    expect(reads.getInventoryTransactions).not.toHaveBeenCalled();
  });

  it("does not load reference collections for an empty page", async () => {
    const response = await fetch(url);
    expect(await response.json()).toEqual([]);
    expect(reads.getWarehouseLocationsByIds).not.toHaveBeenCalled();
    expect(reads.getProductVariantsByIds).not.toHaveBeenCalled();
  });

  it("propagates database failure instead of inventing empty history", async () => {
    reads.getInventoryTransactions.mockRejectedValue(new Error("database unavailable"));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch transactions" });
  });
});
