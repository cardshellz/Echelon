import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permitted: true, permission: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => {
  mocks.permission(resource, action);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.permitted) return res.status(403).json({ error: "Forbidden" });
    Object.assign(req, { user: { id: "operator-1" } });
    return next();
  };
} }));

import { registerProductMergeRoutes } from "../../product-merge.routes";
import { ProductMergeError, type ProductMergeService } from "../../application/product-merge.service";

const RUN = {
  id: 7, status: "completed", sourceProductId: 101, targetProductId: 17, orders: [], result: null,
  errorCode: null, errorMessage: null, createdAt: "2026-11-09T20:00:00.000Z", updatedAt: "2026-11-09T20:00:01.000Z",
};

describe("product merge HTTP boundary", () => {
  let server: Server;
  let base: string;
  const service = { preview: vi.fn(), execute: vi.fn(), getRun: vi.fn(), resume: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.permitted = true;
    const app = express();
    app.use(express.json());
    registerProductMergeRoutes(app, service as unknown as ProductMergeService);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("requires inventory update permission on every endpoint", async () => {
    mocks.permitted = false;
    expect((await call("POST", "/api/products/101/merge/preview", {})).status).toBe(403);
    expect((await call("POST", "/api/products/101/merge", {}, { "Idempotency-Key": "abcdefgh-1234" })).status).toBe(403);
    expect((await call("GET", "/api/product-merges/7")).status).toBe(403);
    expect((await call("POST", "/api/product-merges/7/resume")).status).toBe(403);
    expect(new Set(mocks.permission.mock.calls.map(args => args.join(":")))).toEqual(new Set(["inventory:update"]));
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("rejects non-numeric ids before calling the service", async () => {
    expect((await call("POST", "/api/products/abc/merge/preview", {})).body.code).toBe("MERGE_INVALID_REQUEST");
    expect((await call("GET", "/api/product-merges/0")).status).toBe(400);
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.getRun).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key to start a merge", async () => {
    const response = await call("POST", "/api/products/101/merge", { targetProductId: 17 });
    expect(response.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("starts a merge with the authenticated actor and the idempotency key", async () => {
    service.execute.mockResolvedValue(RUN);
    const body = { targetProductId: 17, adoptSourceSku: true, expectedPreviewHash: "a".repeat(64) };
    const response = await call("POST", "/api/products/101/merge", body, { "Idempotency-Key": "merge-key-0001" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(RUN);
    expect(service.execute).toHaveBeenCalledWith(101, body, "merge-key-0001", "user:operator-1");
  });

  it("maps structured merge errors to their status and code", async () => {
    service.preview.mockRejectedValue(new ProductMergeError("MERGE_PREVIEW_STALE", "changed", 409));
    const response = await call("POST", "/api/products/101/merge/preview", { targetProductId: 17, adoptSourceSku: true });
    expect(response).toEqual({ status: 409, body: { error: "changed", code: "MERGE_PREVIEW_STALE", context: {} } });
  });

  it("hides unexpected internal errors behind a stable code", async () => {
    service.resume.mockRejectedValue(new Error("SELECT secret FROM somewhere"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call("POST", "/api/product-merges/7/resume");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("PRODUCT_MERGE_FAILED");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
