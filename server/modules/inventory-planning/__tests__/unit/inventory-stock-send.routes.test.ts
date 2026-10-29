import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryStockSendRoutes } from "../../interfaces/http/inventory-stock-send.routes";
import { InventoryStockSendError } from "../../application/inventory-stock-send.service";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
describe("stock send HTTP permission and outcome boundary", () => {
  let server: http.Server;
  let url: string;
  let service: { context: ReturnType<typeof vi.fn>; review: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; progress: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    service = { context: vi.fn(async () => ({})), review: vi.fn(async () => ({})),
      send: vi.fn(async () => ({ replayed: false })), progress: vi.fn(async () => ({})) };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "session", { value: { user: { id: "operator" } } }); next(); });
    registerInventoryStockSendRoutes(app, service as never);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/stock-send`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const post = (path: string) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  it("uses view permission for context, read-only review and recorded progress", async () => {
    for (const response of [await fetch(url + "/context?productId=20&channelId=35"), await post("/review"), await fetch(url + "/commands/11111111-1111-4111-8111-111111111111")]) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(service.context).toHaveBeenCalledWith({ productId: 20, channelId: 35 });
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "view");
    expect(service.send).not.toHaveBeenCalled();
  });
  it("requires activation and passes only the authenticated session actor", async () => {
    expect((await post("/send")).status).toBe(202);
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
    expect(service.send).toHaveBeenCalledWith({}, "operator");
    hasPermission.mockResolvedValue(false);
    expect((await post("/send")).status).toBe(403);
    expect(service.send).toHaveBeenCalledTimes(1);
  });
  it("marks a stale review as a definitive refusal and an unknown failure as requiring the same retry identity", async () => {
    service.send.mockRejectedValueOnce(new InventoryStockSendError("STOCK_SEND_REVIEW_STALE", "Review changed."));
    const stale = await post("/send"); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { definitiveRejected: true, code: "STOCK_SEND_REVIEW_STALE" } });
    service.send.mockRejectedValueOnce(new Error("sensitive connection details"));
    const unknown = await post("/send"); expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ error: { definitiveRejected: false, code: "STOCK_SEND_UNCONFIRMED" } });
  });
  it("rejects unexpected query fields and distinguishes a replay from a newly queued update", async () => {
    expect((await fetch(url + "/context?productId=20&actor=spoofed")).status).toBe(400);
    expect(service.context).not.toHaveBeenCalled();
    service.send.mockResolvedValue({ replayed: true });
    expect((await post("/send")).status).toBe(200);
  });
});
