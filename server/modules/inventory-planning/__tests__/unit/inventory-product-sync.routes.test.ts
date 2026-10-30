import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryProductSyncRoutes, registerProductSyncWorkflowRoutes } from "../../interfaces/http/inventory-product-sync.routes";
import { InventoryProductSyncError } from "../../application/inventory-product-sync.service";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
describe("product ATP sync HTTP permission and outcome boundary", () => {
  let server: http.Server;
  let url: string;
  let service: { review: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn>; progress: ReturnType<typeof vi.fn> };
  const workflow = { start: vi.fn(async () => ({})), progress: vi.fn(async () => ({})) };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    service = { review: vi.fn(async () => ({})), sync: vi.fn(async () => ({ replayed: false })), progress: vi.fn(async () => ({})) };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "session", { value: { user: { id: "operator" } } }); next(); });
    registerInventoryProductSyncRoutes(app, service as never);
    workflow.start.mockClear(); workflow.progress.mockClear();
    registerProductSyncWorkflowRoutes(app, workflow as never);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/product-sync`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const post = (path: string) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  it("uses view permission for review and progress without publication", async () => {
    for (const response of [await post("/review"), await fetch(url + "/commands/11111111-1111-4111-8111-111111111111")]) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "view");
    expect(service.sync).not.toHaveBeenCalled();
  });
  it("requires activation permission and passes only the authenticated actor", async () => {
    expect((await post("/sync")).status).toBe(202);
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
    expect(service.sync).toHaveBeenCalledWith({}, "operator");
    hasPermission.mockResolvedValue(false);
    expect((await post("/sync")).status).toBe(403); expect(service.sync).toHaveBeenCalledTimes(1);
  });
  it("requires activation for durable acceptance and actor-scoped view permission for read-only recovery", async () => {
    expect((await post("/requests")).status).toBe(202);
    expect(workflow.start).toHaveBeenCalledWith({}, "operator");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
    expect((await fetch(url+"/requests/11111111-1111-4111-8111-111111111111")).status).toBe(200);
    expect(workflow.progress).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "operator");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "view");
    hasPermission.mockResolvedValue(false);
    expect((await post("/requests")).status).toBe(403);
    expect(workflow.start).toHaveBeenCalledTimes(1);
  });
  it("distinguishes stale refusal, uncertain outcome and replay", async () => {
    service.sync.mockRejectedValueOnce(new InventoryProductSyncError("PRODUCT_SYNC_REVIEW_STALE", "Review changed."));
    const stale = await post("/sync"); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { definitiveRejected: true, code: "PRODUCT_SYNC_REVIEW_STALE" } });
    service.sync.mockRejectedValueOnce(new Error("sensitive connection details"));
    const unknown = await post("/sync"); expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ error: { definitiveRejected: false, code: "PRODUCT_SYNC_UNCONFIRMED" } });
    service.sync.mockResolvedValue({ replayed: true }); expect((await post("/sync")).status).toBe(200);
  });
});
