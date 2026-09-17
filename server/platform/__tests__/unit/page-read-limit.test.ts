import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { awaitPageReads, createPageReadLimiter } from "../../http/page-read-limit";
import { numberedPageQuerySchema, offsetPageQuerySchema } from "../../http/page-query";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function exchange() {
  const request = { aborted: false } as Request;
  const response = { destroyed: false, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return { request, response: response as unknown as Response, next: vi.fn() };
}

describe("heavy page read admission", () => {
  it("shares a finite budget across routes without accumulating pending work", async () => {
    const limit = createPageReadLimiter(2);
    const work = deferred();
    const first = exchange();
    const second = exchange();
    const handlerA = vi.fn(async () => { await work.promise; });
    const handlerB = vi.fn(async () => { await work.promise; });
    const a = limit(handlerA)(first.request, first.response, first.next);
    const b = limit(handlerB)(second.request, second.response, second.next);
    for (let i = 0; i < 100; i++) {
      const denied = exchange();
      await limit(handlerA)(denied.request, denied.response, denied.next);
      expect(denied.response.status).toHaveBeenCalledWith(503);
      expect(denied.response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
      expect(denied.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      expect(denied.response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PAGE_READ_BUSY" }));
    }
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
    // A disconnected browser does not cancel SQL. Its slot stays occupied.
    Object.assign(first.request, { aborted: true });
    Object.assign(first.response, { destroyed: true });
    const denied = exchange();
    await limit(handlerB)(denied.request, denied.response, denied.next);
    expect(handlerB).toHaveBeenCalledOnce();
    work.resolve();
    await Promise.all([a, b]);
    const resumed = exchange();
    await limit(handlerA)(resumed.request, resumed.response, resumed.next);
    expect(handlerA).toHaveBeenCalledTimes(2);
  });

  it("releases after failure, reports it through Express, and skips abandoned requests", async () => {
    const limit = createPageReadLimiter(1);
    const error = new Error("database unavailable");
    const failed = exchange();
    await limit(async () => { throw error; })(failed.request, failed.response, failed.next);
    expect(failed.next).toHaveBeenCalledExactlyOnceWith(error);
    const handler = vi.fn(async () => undefined);
    const abandoned = exchange();
    Object.assign(abandoned.request, { aborted: true });
    await limit(handler)(abandoned.request, abandoned.response, abandoned.next);
    expect(handler).not.toHaveBeenCalled();
    const recovered = exchange();
    await limit(handler)(recovered.request, recovered.response, recovered.next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid concurrency %s", invalid => {
    expect(() => createPageReadLimiter(invalid)).toThrow(RangeError);
  });

  it("drains sibling reads before releasing a slot after an early query failure", async () => {
    const limit = createPageReadLimiter(1);
    const pending = deferred();
    const error = new Error("count query failed");
    const first = exchange();
    const started = limit(async () => {
      await awaitPageReads([Promise.reject(error), pending.promise]);
    })(first.request, first.response, first.next);
    await Promise.resolve();
    const second = exchange();
    const read = vi.fn(async () => undefined);
    await limit(read)(second.request, second.response, second.next);
    expect(second.response.status).toHaveBeenCalledWith(503);
    expect(first.next).not.toHaveBeenCalled();
    pending.resolve();
    await started;
    expect(first.next).toHaveBeenCalledWith(error);
    expect(await awaitPageReads([Promise.resolve(1), "two"])).toEqual([1, "two"]);
  });

  it("keeps HTTP health and writes responsive during a burst of blocked page reads", async () => {
    const app = express();
    const limit = createPageReadLimiter(1);
    const entered = deferred();
    const release = deferred();
    app.get("/slow", limit(async (_req, res) => { entered.resolve(); await release.promise; res.json({ ok: true }); }));
    app.get("/other-page", limit(async (_req, res) => { res.json({ ok: true }); }));
    app.get("/health", (_req, res) => { res.json({ ok: true }); });
    app.post("/write", (_req, res) => { res.json({ accepted: true }); });
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: String(error) }); });
    const server = createServer(app);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pending = fetch(url + "/slow");
      await entered.promise;
      const burst = await Promise.all(Array.from({ length: 20 }, () => fetch(url + "/other-page")));
      for (const response of burst) {
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "PAGE_READ_BUSY" });
      }
      expect((await fetch(url + "/health")).status).toBe(200);
      expect((await fetch(url + "/write", { method: "POST" })).status).toBe(200);
      release.resolve();
      expect((await pending).status).toBe(200);
      expect((await fetch(url + "/other-page")).status).toBe(200);
    } finally {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});

describe("page size boundaries", () => {
  it("defaults to 50 and supports the maximum of 200", () => {
    expect(offsetPageQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(numberedPageQuerySchema.parse({})).toEqual({ limit: 50, page: 1 });
    expect(offsetPageQuerySchema.parse({ limit: "200", offset: "100" })).toEqual({ limit: 200, offset: 100 });
  });
  it.each([0, -1, 201, 1000000, Infinity, NaN, "", "2.5", "50suffix", ["50"], true, null, {}])("rejects unsafe page size %j", limit => {
    expect(offsetPageQuerySchema.safeParse({ limit }).success).toBe(false);
    expect(numberedPageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
  it("rejects negative or overflowing offsets, including page multiplication", () => {
    for (const offset of [-1, 2_147_483_648, 0.5]) expect(offsetPageQuerySchema.safeParse({ offset }).success).toBe(false);
    expect(numberedPageQuerySchema.safeParse({ page: "2147483647", limit: "200" }).success).toBe(false);
    expect(numberedPageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("page protection wiring", () => {
  it.each([
    ["server/modules/channels/channels.routes.ts", ["/api/wms/orders", "/api/channel-allocation/grid"]],
    ["server/modules/orders/picking.routes.ts", ["/api/picking/queue", "/api/orders", "/api/orders/history"]],
    ["server/modules/orders/picking-history.routes.ts", ["/api/picking/history"]],
    ["server/modules/inventory/inventory.routes.ts", ["/api/inventory/transactions"]],
    ["server/routes/oms.routes.ts", ["/api/oms/orders"]],
    ["server/modules/shipping-engine/outbound-shipments.routes.ts", ["/api/outbound-shipments"]],
  ] as const)("places the shared limiter after authentication in %s", (path, routes) => {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const protectedRoutes: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get") {
        const [url, auth, handler] = node.arguments;
        if (url && ts.isStringLiteral(url) && (routes as readonly string[]).includes(url.text)) {
          expect(auth.getText(source)).toMatch(/^require(Auth|Permission)/);
          expect(ts.isCallExpression(handler) && handler.expression.getText(source) === "limitPageRead").toBe(true);
          protectedRoutes.push(url.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(protectedRoutes.sort()).toEqual([...routes].sort());
  });
});
