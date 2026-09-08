import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ permission: vi.fn(), read: vi.fn(), history: vi.fn(), update: vi.fn() }));
vi.mock("../../../../modules/identity", () => ({ hasPermission: mocks.permission }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../supplier-sourcing.service", async (original) => ({
  ...await original<typeof import("../../supplier-sourcing.service")>(),
  SupplierSourcingService: class { read = mocks.read; history = mocks.history; update = mocks.update; },
}));
import { registerSupplierSourcingRoutes } from "../../supplier-sourcing.routes";
import { SupplierSourcingError } from "../../supplier-sourcing.service";

describe("supplier sourcing HTTP authority", () => {
  let server: http.Server;
  let origin: string;
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.permission.mockResolvedValue(true);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: req.header("X-Test-Actor") ? { id: req.header("X-Test-Actor") } : undefined } as never; next(); });
    registerSupplierSourcingRoutes(app); server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  function request(path: string, body?: unknown, actor: string | null = "reviewer") {
    return fetch(origin + path, { method: body === undefined ? "GET" : "PUT", headers: { "Content-Type": "application/json", ...(actor ? { "X-Test-Actor": actor } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  it("requires edit permission and an authenticated actor before a mutation", async () => {
    mocks.permission.mockResolvedValue(false);
    expect((await request("/api/vendor-products/20/sourcing", {})).status).toBe(403);
    expect(mocks.permission).toHaveBeenCalledWith("reviewer", "purchasing", "edit");
    expect((await request("/api/vendor-products/20/sourcing", {}, null)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("reads current and paginated history with inventory view permission", async () => {
    mocks.read.mockResolvedValue({ revision: 2 }); mocks.history.mockResolvedValue({ records: [], nextBeforeRevision: null });
    expect((await request("/api/vendor-products/20/sourcing")).status).toBe(200);
    expect((await request("/api/vendor-products/20/sourcing/history?beforeRevision=2")).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(20); expect(mocks.history).toHaveBeenCalledWith(20, 2);
    expect(mocks.permission).toHaveBeenCalledWith("reviewer", "inventory", "view");
  });
  it.each(["0", "1e2", "2147483648"])("rejects invalid supplier identity %s before a read", async (id) => {
    expect((await request(`/api/vendor-products/${id}/sourcing`)).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("passes the actual operator and exact command body and returns replay identity", async () => {
    const body = { expectedRevision: 1, idempotencyKey: "test-key", reason: "Operator policy change" };
    mocks.update.mockResolvedValue({ record: { revision: 2 }, reused: true });
    const response = await request("/api/vendor-products/20/sourcing", body, "delegate");
    expect(response.headers.get("Idempotency-Replayed")).toBe("true"); expect(await response.json()).toEqual({ revision: 2 });
    expect(mocks.update).toHaveBeenCalledWith(20, body, "delegate");
  });
  it("returns classified conflicts and hides unknown infrastructure errors", async () => {
    mocks.update.mockRejectedValueOnce(new SupplierSourcingError("SUPPLIER_SOURCING_STALE", "Reload the newer revision", 409));
    expect((await request("/api/vendor-products/20/sourcing", {})).status).toBe(409);
    mocks.read.mockRejectedValueOnce(new Error("SECRET_CONNECTION_STRING"));
    const response = await request("/api/vendor-products/20/sourcing");
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("SECRET_CONNECTION_STRING");
    expect(console.error).toHaveBeenCalled();
  });
});
