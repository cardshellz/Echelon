import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InventoryQuantityError } from "../../domain/quantity-ledger";

const state = vi.hoisted(() => ({
  tx: { execute: vi.fn() }, transaction: vi.fn(),
  storage: { getAdjustmentReasonByCode: vi.fn(), getWarehouseLocationByCode: vi.fn(),
    getProductVariantBySku: vi.fn(), getProductById: vi.fn(),
    getInventoryLevelByLocationAndVariant: vi.fn(), adjustInventoryLevel: vi.fn(),
    upsertInventoryLevel: vi.fn(), createInventoryLevel: vi.fn(), createInventoryTransaction: vi.fn() },
}));
vi.mock("../../../../db", () => ({ db: { transaction: state.transaction }, pool: {} }));
vi.mock("../../index", () => ({ inventoryStorage: state.storage }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../infrastructure/quantity-authority.query", () => ({ readInventoryQuantityCapabilities: vi.fn(async () => ({ legacyQuantityImportAllowed: true })) }));
vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { requirePermission: () => pass, requireAuth: pass, upload: { single: () => pass } };
});
import { registerInventoryRoutes } from "../../inventory.routes";

describe("CSV counts cannot recognize pending receiving custody", () => {
  let server: Server;
  let baseUrl: string;
  let committed: boolean;
  const guard = vi.fn();
  const adjustInventory = vi.fn();
  const withTx = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    committed = false;
    state.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const result = await work(state.tx); committed = true; return result;
    });
    state.storage.getWarehouseLocationByCode.mockResolvedValue({ id: 2 });
    state.storage.getProductVariantBySku.mockResolvedValue({ id: 101, productId: 10 });
    state.storage.getProductById.mockResolvedValue({ id: 10 });
    state.storage.getInventoryLevelByLocationAndVariant.mockResolvedValue(undefined);
    withTx.mockImplementation((tx: unknown) => {
      expect(tx).toBe(state.tx);
      return { assertCountableCustody: guard, adjustInventory };
    });
    guard.mockRejectedValue(new InventoryQuantityError("RECEIVING_CUSTODY_COUNT_CONFLICT", "Resolve receiving quarantine for receipt 77"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { user: { id: "operator", role: "admin" } } as Request["session"];
      req.file = { buffer: Buffer.from("location_code,sku,quantity\nA-01,SKU-1,10\n") } as Express.Multer.File;
      next();
    });
    app.locals.services = { inventoryCore: { withTx } } as unknown as typeof app.locals.services;
    registerInventoryRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each(["upload-csv", "import-csv"])("rejects %s before old/missing balance reads and writes", async path => {
    const response = await fetch(`${baseUrl}/api/inventory/${path}`, { method: "POST" });
    const body = await response.json();
    expect(response.status).toBe(200); // Both legacy batch contracts return per-row failures.
    expect(JSON.stringify(body)).toContain("Resolve receiving quarantine for receipt 77");
    expect(guard).toHaveBeenCalledWith({ productVariantId: 101, warehouseLocationId: 2 });
    expect(committed).toBe(false);
    expect(state.storage.getInventoryLevelByLocationAndVariant).not.toHaveBeenCalled();
    expect(state.storage.createInventoryLevel).not.toHaveBeenCalled();
    expect(state.storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(state.storage.upsertInventoryLevel).not.toHaveBeenCalled();
    expect(state.storage.createInventoryTransaction).not.toHaveBeenCalled();
    expect(adjustInventory).not.toHaveBeenCalled();
  });

  it("creates an unheld CSV row and its evidence in the guarded transaction", async () => {
    guard.mockResolvedValue(undefined);
    const response = await fetch(`${baseUrl}/api/inventory/import-csv`, { method: "POST" });
    expect(await response.json()).toMatchObject({ processed: 1, created: 1, errors: [] });
    expect(state.storage.createInventoryLevel).toHaveBeenCalledWith(expect.objectContaining({ productVariantId: 101, variantQty: 10 }), state.tx);
    expect(state.storage.createInventoryTransaction).toHaveBeenCalledWith(expect.objectContaining({ productVariantId: 101, variantQtyDelta: 10 }), state.tx);
    expect(committed).toBe(true);
  });
});
