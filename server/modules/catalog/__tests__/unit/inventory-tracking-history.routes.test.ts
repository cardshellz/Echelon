import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryTrackingHistoryRoutes } from "../../inventory-tracking-history.routes";

const mocks = vi.hoisted(() => ({ list: vi.fn(), export: vi.fn(), permitted: true }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../inventory/infrastructure/tracking-stop.repository", () => ({
  listTrackingStopHistory: mocks.list, exportTrackingStopHistory: mocks.export,
}));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => {
  expect([resource, action]).toEqual(["inventory", "view"]);
  return (_req: Request, res: Response, next: NextFunction) => mocks.permitted ? next() : res.sendStatus(403);
} }));

describe("inventory tracking history HTTP boundary", () => {
  let server: Server; let base: string;
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.permitted = true;
    mocks.list.mockResolvedValue({ records: [], hasMore: false });
    mocks.export.mockResolvedValue(null);
    const app = express(); registerInventoryTrackingHistoryRoutes(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  function get(path: string) {
    return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get(base + path, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
        res.on("error", reject);
      }).on("error", reject);
    });
  }
  const path = "/api/products/1/inventory-tracking/history";
  it("requires inventory view permission for both reads", async () => {
    mocks.permitted = false;
    expect((await get(path)).status).toBe(403);
    expect((await get(path + "/1")).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.export).not.toHaveBeenCalled();
  });
  it.each(["/api/products/0/inventory-tracking/history", path + "?before=-1", path + "?before=9223372036854775808", path + "/1.5"])(
    "rejects invalid identity %s before a database read", async endpoint => {
      expect((await get(endpoint)).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.export).not.toHaveBeenCalled();
    });
  it("passes the exact bigint page cursor and disables caching", async () => {
    expect(await get(path + "?before=9007199254740993")).toMatchObject({ status: 200, text: '{"records":[],"hasMore":false}', headers: { "cache-control": "no-store" } });
    expect(mocks.list).toHaveBeenCalledWith({}, 1, "9007199254740993");
  });
  it("exports original JSON bytes without rounding bigint costs", async () => {
    const document = '{"lots":[{"unit_cost_mills":9007199254740993}]}';
    mocks.export.mockResolvedValue(document);
    expect(await get(path + "/7")).toMatchObject({ status: 200, text: document, headers: {
      "content-disposition": 'attachment; filename="inventory-tracking-history-7.json"', "cache-control": "no-store",
    } });
    expect(mocks.export).toHaveBeenCalledWith({}, 1, "7");
  });
  it("distinguishes missing history from unavailable history", async () => {
    expect((await get(path + "/7")).status).toBe(404);
    mocks.export.mockRejectedValue(new Error("private database error"));
    const failed = await get(path + "/7");
    expect(failed.status).toBe(500); expect(failed.text).not.toContain("private database error");
    mocks.list.mockRejectedValue(new Error("private database error"));
    expect((await get(path)).status).toBe(500);
  });
});
