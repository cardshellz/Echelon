import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== "test-session") return res.status(401).json({ error: "Unauthorized" });
    next();
  },
}));
import { registerPickingHistoryRoutes } from "../../picking-history.routes";
import { PickingHistoryRepository } from "../../picking-history.repository";
import { db } from "../../../../db";

describe("bounded all-date picking history HTTP contract", () => {
  const page = vi.fn<PickingHistoryRepository["page"]>();
  let server: Server;
  let url: string;
  beforeEach(async () => {
    page.mockReset().mockResolvedValue({ orders: [], total: 0, limit: 50, offset: 0 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = express();
    registerPickingHistoryRoutes(app, { page });
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/picking/history`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });
  const get = (query = "") => fetch(url + query, { headers: { authorization: "test-session" } });

  it("requires authentication before reading any history", async () => {
    expect((await fetch(url)).status).toBe(401);
    expect(page).not.toHaveBeenCalled();
  });
  it("defaults to a 50-order page without any date cutoff", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(page).toHaveBeenCalledExactlyOnceWith({ limit: 50, offset: 0, search: "" });
    expect(await response.json()).toMatchObject({ total: 0, orders: [] });
  });
  it("preserves explicit channel and warehouse scope with normalized search", async () => {
    expect((await get("?limit=100&offset=200&search=%20%2362770%20&channelId=2&warehouseId=3&provider=shopify")).status).toBe(200);
    expect(page).toHaveBeenCalledExactlyOnceWith({ limit: 100, offset: 200, search: "#62770", channelId: 2, warehouseId: 3, provider: "shopify" });
  });
  it.each(["limit=0", "limit=101", "limit=50x", "limit=2.5", "limit=50&limit=50", "offset=-1", "offset=2147483648", "warehouseId=0", "channelId=abc", "search=" + "x".repeat(201), "search=a&search=b"])("rejects invalid %s before database work", async query => {
    expect((await get("?" + query)).status).toBe(400);
    expect(page).not.toHaveBeenCalled();
  });
  it("reports failure rather than inventing an empty successful page", async () => {
    page.mockRejectedValueOnce(new Error("private database error"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "PICKING_HISTORY_READ_FAILED", error: "Failed to load picking history. Please retry." });
    expect(console.error).toHaveBeenCalledOnce();
  });
  it("also rejects invalid internal reads without touching the database", async () => {
    const repository = new PickingHistoryRepository(db);
    await expect(repository.page({ limit: 101 })).rejects.toThrow("History pages");
    await expect(repository.page({ channelId: -1 })).rejects.toThrow();
  });
  it("does not repurpose the active queue or its self-healing reads for history", () => {
    const source = readFileSync(resolve(__dirname, "../../picking-history.repository.ts"), "utf8");
    expect(source).toContain('accessMode: "read only"');
    expect(source).not.toMatch(/getPickQueue|\.insert\(|\.update\(|\.delete\(|NOW\(\)|INTERVAL/i);
    const active = readFileSync(resolve(__dirname, "../../orders.storage.ts"), "utf8");
    const queueSql = active.slice(active.indexOf("async getPickQueueOrders"), active.indexOf("const orderRows ="));
    expect(queueSql).not.toContain("24 hours");
    expect(queueSql).not.toContain("o.warehouse_status = 'completed'");
  });
});
