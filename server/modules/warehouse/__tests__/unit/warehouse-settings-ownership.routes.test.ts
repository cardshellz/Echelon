import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WarehouseSettingsWriteError } from "../../domain/warehouse-settings-write";

const h = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), remove: vi.fn(), current: vi.fn(), defaults: vi.fn(),
  guarded: vi.fn(), legacy: vi.fn(), checkLegacy: vi.fn(),
}));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { session: { user: { id: "warehouse-manager" } } }); next();
  },
}));
vi.mock("../../../../storage/base", () => ({ db: {} }));
vi.mock("../../", () => ({ createBinAssignmentService: () => ({}), warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {
  createWarehouseSettings: h.create, updateWarehouseSettings: h.update, deleteWarehouseSettings: h.remove,
  getWarehouseSettingsById: h.current, getDefaultWarehouseSettings: h.defaults,
} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-legacy-admin-control.repository", () => ({
  createInventoryLegacyAdminControlService: () => ({ executeGuardedLegacyWrite: h.guarded, executeLegacyWrite: h.legacy }),
}));
import { registerWarehouseRoutes } from "../../warehouse.routes";

describe("warehouse settings HTTP ownership", () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    h.current.mockResolvedValue({ id: 1, warehouseCode: "DEFAULT", warehouseId: null, channelSyncEnabled: 0, channelSyncIntervalMinutes: 15 });
    h.update.mockResolvedValue({ id: 1 }); h.create.mockResolvedValue({ id: 2 });
    h.guarded.mockImplementation(async (_control: unknown, run: (guard: unknown, tx: unknown) => unknown) => run({ assertLegacyMutation: h.checkLegacy }, {}));
    h.legacy.mockImplementation(async (_control: unknown, run: (tx: unknown) => unknown) => run({}));
    const app = express(); app.use(express.json()); registerWarehouseRoutes(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const request = (method: string, path: string, body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  it.each(["POST", "PATCH"])("rejects procurement injection through %s before storage or legacy adapters", async method => {
    const result = await request(method, "/api/warehouse-settings" + (method === "PATCH" ? "/1" : ""), {
      requireApproval: false, inlineReplenMaxUnits: 0,
    });
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ details: { code: "PROCUREMENT_SETTINGS_OWNER_REQUIRED" } });
    expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.guarded).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled();
  });

  it("rejects previously unsupported forecast fields on POST before reaching storage", async () => {
    const result = await request("POST", "/api/warehouse-settings", {
      warehouseCode: "NORTH", inlineReplenMaxUnits: 0, purchasingForecastMethod: "weighted_blend_v1",
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ details: { code: "WAREHOUSE_SETTINGS_CREATE_FIELDS_UNSUPPORTED" } });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("keeps allowed generic writes and valid zero creation values", async () => {
    expect((await request("POST", "/api/warehouse-settings", { warehouseCode: "NORTH", inlineReplenMaxUnits: 0 })).status).toBe(201);
    expect(h.create).toHaveBeenCalledWith({ warehouseCode: "NORTH", inlineReplenMaxUnits: 0 }, expect.anything());
    expect((await request("PATCH", "/api/warehouse-settings/1", { inlineReplenMaxUnits: 0 })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(1, { inlineReplenMaxUnits: 0 }, expect.anything());
  });

  it("retains the canonical inventory channel-control check for changed settings", async () => {
    expect((await request("PATCH", "/api/warehouse-settings/1", { channelSyncEnabled: 1 })).status).toBe(200);
    expect(h.checkLegacy).toHaveBeenCalledOnce();
  });

  it.each(["0", "1junk", "-1", "2147483648"])("rejects malformed id %s before reading or writing", async id => {
    expect((await request("PATCH", `/api/warehouse-settings/${id}`, { isActive: 1 })).status).toBe(400);
    expect((await request("DELETE", `/api/warehouse-settings/${id}`)).status).toBe(400);
    expect(h.current).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });

  it("returns the repository DEFAULT protection conflict without converting it to 500", async () => {
    h.remove.mockRejectedValue(new WarehouseSettingsWriteError("DEFAULT cannot be deleted", 409, "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED"));
    const result = await request("DELETE", "/api/warehouse-settings/1");
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ details: { code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" } });
  });

  it("preserves fixed-default bootstrap with no caller-controlled procurement fields", async () => {
    h.defaults.mockResolvedValue(undefined);
    expect((await request("GET", "/api/warehouse-settings/default")).status).toBe(200);
    expect(h.create).toHaveBeenCalledWith({ warehouseCode: "DEFAULT", warehouseName: "Main Warehouse" });
  });
});
