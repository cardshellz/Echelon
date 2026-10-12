import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerListingLifecycleRoutes } from "../../interfaces/http/listing-lifecycle.routes";

vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) =>
  (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.headers["x-permission"] !== `${resource}:${action}`) { response.status(403).json({ error: "Forbidden" }); return; }
    Object.assign(request, { session: { user: { id: "operator-1" } } });
    next();
  } }));

describe("listing lifecycle HTTP boundary", () => {
  let server: Server, base: string, app: express.Express;
  const service = { list: vi.fn(), history: vi.fn(), request: vi.fn(), refresh: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    app = express(); app.use(express.json());
    Object.assign(app.locals, { services: { listingLifecycle: service } });
    registerListingLifecycleRoutes(app);
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/channels/104/listing-lifecycle`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const post = (path: string, body: unknown, permission = "channels:edit") => fetch(`${base}${path}`, {
    method: "POST", headers: { "x-permission": permission, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  it.each(["", "/status"])("requires edit permission for %s", async path => {
    expect((await post(path, { sku: "SKU" }, "channels:view")).status).toBe(403);
    expect(service.request).not.toHaveBeenCalled(); expect(service.refresh).not.toHaveBeenCalled();
  });
  it("requires view permission even for read-only lookup", async () => {
    expect((await post("/lookup", { skus: ["SKU"] }, "")).status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
    expect((await post("/history", {}, "")).status).toBe(403);
    expect(service.history).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor and URL channel for both actions", async () => {
    service.request.mockResolvedValue({ state: "pending" });
    for (const action of ["unpublish", "remove"]) {
      const body = { sku: "SKU", action, actor: "forged", channelId: 999 };
      expect((await post("", body)).status).toBe(200);
      expect(service.request).toHaveBeenLastCalledWith(104, body, "operator-1");
    }
  });
  it("passes only validated SKUs to lookup and status", async () => {
    service.list.mockResolvedValue({ items: [] }); service.refresh.mockResolvedValue({ state: "retiring" });
    expect((await post("/lookup", { skus: ["SKU"] }, "channels:view")).status).toBe(200);
    expect(service.list).toHaveBeenCalledExactlyOnceWith(104, ["SKU"]);
    expect((await post("/status", { sku: "SKU" })).status).toBe(200);
    expect(service.refresh).toHaveBeenCalledExactlyOnceWith(104, "SKU");
  });
  it.each([
    ["/lookup", { skus: Array(251).fill("SKU") }], ["/lookup", { skus: [""] }],
    ["/status", { sku: "SKU", actor: "forged" }], ["/status", { sku: "X".repeat(51) }],
  ])("rejects invalid input to %s", async (path, body) => {
    expect((await post(path, body, path === "/lookup" ? "channels:view" : "channels:edit")).status).toBe(400);
    expect(service.list).not.toHaveBeenCalled(); expect(service.refresh).not.toHaveBeenCalled();
  });
  it("rejects invalid channel IDs before invoking the owner", async () => {
    base = base.replace("/104/", "/-1/");
    expect((await post("", {})).status).toBe(400); expect(service.request).not.toHaveBeenCalled();
  });
  it("reports missing composition and never exposes unknown exception bodies", async () => {
    service.request.mockRejectedValue(new Error("secret-database-string"));
    const response = await post("", {});
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("secret-database-string");
    Object.assign(app.locals, { services: {} });
    expect((await post("", {})).status).toBe(503);
  });
});
