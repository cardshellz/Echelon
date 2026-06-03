import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import type { AddressInfo } from "net";

// Route-level tests for the dedicated, warehouse-keyed SLA cutoff endpoints.
// We mount the real warehouse routes with mocked deps so the HTTP wiring +
// validation + upsert branching are exercised, while keeping the real
// sort-rank validators (so a value the API accepts is one the engine accepts).

const h = vi.hoisted(() => ({
  getAllWarehouseSettings: vi.fn(),
  updateWarehouseSettings: vi.fn(),
  createWarehouseSettings: vi.fn(),
  getWarehouseById: vi.fn(),
  getSlaCutoffConfig: vi.fn(),
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return { requirePermission: () => pass, requireAuth: pass, requireInternalApiKey: pass, upload: { single: () => pass } };
});
vi.mock("../../../../storage/base", () => ({ db: {} }));
vi.mock("../../", () => ({ createBinAssignmentService: () => ({}), warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../inventory", () => ({
  inventoryStorage: {
    getAllWarehouseSettings: h.getAllWarehouseSettings,
    updateWarehouseSettings: h.updateWarehouseSettings,
    createWarehouseSettings: h.createWarehouseSettings,
  },
}));
vi.mock("../../infrastructure/warehouse.repository", () => ({ getWarehouseById: h.getWarehouseById }));
vi.mock("../../settings.resolver", () => ({ getSlaCutoffConfig: h.getSlaCutoffConfig }));

import { registerWarehouseRoutes } from "../../warehouse.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  registerWarehouseRoutes(app);
  return app;
}

// Dependency-light request helper: mount the app on an ephemeral port and fetch.
function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
async function req(base: string, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("PUT /api/warehouse-settings/:warehouseId/sla-cutoff", () => {
  let base: string, close: () => Promise<void>;
  beforeEach(async () => {
    vi.clearAllMocks();
    h.getWarehouseById.mockResolvedValue({ id: 1, code: "LEON", name: "20 LEONBERG" });
    ({ url: base, close } = await startServer(buildApp()));
  });
  afterEach(() => close());

  it("creates a settings row when the warehouse has none (upsert → create)", async () => {
    h.getAllWarehouseSettings.mockResolvedValue([]); // no row for this warehouse yet
    h.createWarehouseSettings.mockResolvedValue({ id: 9, warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York" });

    const res = await req(base, "PUT", "/api/warehouse-settings/1/sla-cutoff", { orderCutoffLocal: "14:00", timezone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York" });
    expect(h.createWarehouseSettings).toHaveBeenCalledWith(expect.objectContaining({
      warehouseId: 1, warehouseCode: "LEON", orderCutoffLocal: "14:00", timezone: "America/New_York",
    }));
    expect(h.updateWarehouseSettings).not.toHaveBeenCalled();
  });

  it("updates the existing row when the warehouse already has one (upsert → update)", async () => {
    h.getAllWarehouseSettings.mockResolvedValue([{ id: 9, warehouseId: 1, orderCutoffLocal: "12:00", timezone: "America/New_York" }]);
    h.updateWarehouseSettings.mockResolvedValue({ id: 9, warehouseId: 1, orderCutoffLocal: "15:30", timezone: "America/Chicago" });

    const res = await req(base, "PUT", "/api/warehouse-settings/1/sla-cutoff", { orderCutoffLocal: "15:30", timezone: "America/Chicago" });

    expect(res.status).toBe(200);
    expect(h.updateWarehouseSettings).toHaveBeenCalledWith(9, { orderCutoffLocal: "15:30", timezone: "America/Chicago" });
    expect(h.createWarehouseSettings).not.toHaveBeenCalled();
  });

  it("allows clearing the cutoff (null disables it)", async () => {
    h.getAllWarehouseSettings.mockResolvedValue([{ id: 9, warehouseId: 1 }]);
    h.updateWarehouseSettings.mockResolvedValue({ id: 9, warehouseId: 1, orderCutoffLocal: null, timezone: null });
    const res = await req(base, "PUT", "/api/warehouse-settings/1/sla-cutoff", { orderCutoffLocal: null, timezone: null });
    expect(res.status).toBe(200);
    expect(h.updateWarehouseSettings).toHaveBeenCalledWith(9, { orderCutoffLocal: null, timezone: null });
  });

  it("rejects a malformed cutoff with 400 (no write)", async () => {
    const res = await req(base, "PUT", "/api/warehouse-settings/1/sla-cutoff", { orderCutoffLocal: "25:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/HH:MM/);
    expect(h.updateWarehouseSettings).not.toHaveBeenCalled();
    expect(h.createWarehouseSettings).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone with 400 (no write)", async () => {
    const res = await req(base, "PUT", "/api/warehouse-settings/1/sla-cutoff", { timezone: "America/New York" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/IANA/);
  });

  it("404s for an unknown warehouse", async () => {
    h.getWarehouseById.mockResolvedValue(undefined);
    const res = await req(base, "PUT", "/api/warehouse-settings/999/sla-cutoff", { orderCutoffLocal: "14:00" });
    expect(res.status).toBe(404);
  });

  it("400s for a non-numeric warehouseId", async () => {
    const res = await req(base, "PUT", "/api/warehouse-settings/abc/sla-cutoff", { orderCutoffLocal: "14:00" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/warehouse-settings/:warehouseId/sla-cutoff", () => {
  let base: string, close: () => Promise<void>;
  beforeEach(async () => {
    vi.clearAllMocks();
    h.getWarehouseById.mockResolvedValue({ id: 1, code: "LEON", name: "20 LEONBERG" });
    ({ url: base, close } = await startServer(buildApp()));
  });
  afterEach(() => close());

  it("returns the effective config + inherited flag when the warehouse has its own row", async () => {
    h.getAllWarehouseSettings.mockResolvedValue([{ id: 9, warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York" }]);
    h.getSlaCutoffConfig.mockResolvedValue({ cutoffLocal: "14:00", timezone: "America/New_York" });

    const res = await req(base, "GET", "/api/warehouse-settings/1/sla-cutoff");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York", inherited: false,
      explicit: { orderCutoffLocal: "14:00", timezone: "America/New_York" },
    });
  });

  it("flags inherited=true when the warehouse has no override (falls back to DEFAULT)", async () => {
    h.getAllWarehouseSettings.mockResolvedValue([]); // no row for this warehouse
    h.getSlaCutoffConfig.mockResolvedValue({ cutoffLocal: "14:00", timezone: "America/New_York" }); // resolved from DEFAULT
    const res = await req(base, "GET", "/api/warehouse-settings/1/sla-cutoff");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ warehouseId: 1, inherited: true, explicit: null, orderCutoffLocal: "14:00" });
  });
});
