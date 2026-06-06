import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import type { AddressInfo } from "net";

// Route-level tests for the dedicated, warehouse-keyed SLA cutoff endpoints.
// The cutoff + timezone live on the warehouse row; these endpoints are a focused
// alias for reading/setting just those two fields. We mount the real warehouse
// routes with mocked deps, keeping the real sort-rank validators.

const h = vi.hoisted(() => ({
  updateWarehouse: vi.fn(),
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
vi.mock("../../", () => ({ createBinAssignmentService: () => ({}), warehouseStorage: { updateWarehouse: h.updateWarehouse } }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../infrastructure/warehouse.repository", () => ({ getWarehouseById: h.getWarehouseById }));
vi.mock("../../settings.resolver", () => ({ getSlaCutoffConfig: h.getSlaCutoffConfig }));

import { registerWarehouseRoutes } from "../../warehouse.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  registerWarehouseRoutes(app);
  return app;
}
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

describe("PUT /api/warehouses/:id/sla-cutoff", () => {
  let base: string, close: () => Promise<void>;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ url: base, close } = await startServer(buildApp()));
  });
  afterEach(() => close());

  it("writes the cutoff + timezone to the warehouse row", async () => {
    h.updateWarehouse.mockResolvedValue({ id: 1, orderCutoffLocal: "14:00", timezone: "America/New_York" });
    const res = await req(base, "PUT", "/api/warehouses/1/sla-cutoff", { orderCutoffLocal: "14:00", timezone: "America/New_York" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York" });
    expect(h.updateWarehouse).toHaveBeenCalledWith(1, { orderCutoffLocal: "14:00", timezone: "America/New_York" });
  });

  it("allows clearing the cutoff (null disables it)", async () => {
    h.updateWarehouse.mockResolvedValue({ id: 1, orderCutoffLocal: null, timezone: null });
    const res = await req(base, "PUT", "/api/warehouses/1/sla-cutoff", { orderCutoffLocal: null, timezone: null });
    expect(res.status).toBe(200);
    expect(h.updateWarehouse).toHaveBeenCalledWith(1, { orderCutoffLocal: null, timezone: null });
  });

  it("only updates fields that are present in the body", async () => {
    h.updateWarehouse.mockResolvedValue({ id: 1, orderCutoffLocal: "15:00", timezone: "America/New_York" });
    await req(base, "PUT", "/api/warehouses/1/sla-cutoff", { orderCutoffLocal: "15:00" });
    expect(h.updateWarehouse).toHaveBeenCalledWith(1, { orderCutoffLocal: "15:00" });
  });

  it("rejects a cutoff on a bulk_storage hub (400, no write)", async () => {
    h.getWarehouseById.mockResolvedValueOnce({ id: 2, code: "RTE-19", warehouseType: "bulk_storage" });
    const res = await req(base, "PUT", "/api/warehouses/2/sla-cutoff", { orderCutoffLocal: "14:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/storage hub|bulk_storage/i);
    expect(h.updateWarehouse).not.toHaveBeenCalled();
  });

  it("rejects a malformed cutoff with 400 (no write)", async () => {
    const res = await req(base, "PUT", "/api/warehouses/1/sla-cutoff", { orderCutoffLocal: "25:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/HH:MM/);
    expect(h.updateWarehouse).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone with 400 (no write)", async () => {
    const res = await req(base, "PUT", "/api/warehouses/1/sla-cutoff", { timezone: "America/New York" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/IANA/);
    expect(h.updateWarehouse).not.toHaveBeenCalled();
  });

  it("404s when the warehouse doesn't exist", async () => {
    h.updateWarehouse.mockResolvedValue(null);
    const res = await req(base, "PUT", "/api/warehouses/999/sla-cutoff", { orderCutoffLocal: "14:00" });
    expect(res.status).toBe(404);
  });

  it("400s for a non-numeric warehouse id", async () => {
    const res = await req(base, "PUT", "/api/warehouses/abc/sla-cutoff", { orderCutoffLocal: "14:00" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/warehouses/:id/sla-cutoff", () => {
  let base: string, close: () => Promise<void>;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ url: base, close } = await startServer(buildApp()));
  });
  afterEach(() => close());

  it("returns the warehouse's own cutoff/tz plus the effective (fallback) values", async () => {
    h.getWarehouseById.mockResolvedValue({ id: 1, code: "LEON", name: "20 LEONBERG", orderCutoffLocal: "14:00", timezone: "America/New_York" });
    h.getSlaCutoffConfig.mockResolvedValue({ cutoffLocal: "14:00", timezone: "America/New_York" });
    const res = await req(base, "GET", "/api/warehouses/1/sla-cutoff");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      warehouseId: 1, orderCutoffLocal: "14:00", timezone: "America/New_York",
      effective: { orderCutoffLocal: "14:00", timezone: "America/New_York" },
    });
  });

  it("404s for an unknown warehouse", async () => {
    h.getWarehouseById.mockResolvedValue(undefined);
    const res = await req(base, "GET", "/api/warehouses/999/sla-cutoff");
    expect(res.status).toBe(404);
  });
});
