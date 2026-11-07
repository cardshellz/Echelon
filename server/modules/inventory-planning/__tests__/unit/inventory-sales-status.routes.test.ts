import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SalesStatusError } from "../../domain/inventory-sales-status";
import { registerSalesStatusRoutes, SALES_STATUS_API_BASE } from "../../interfaces/http/inventory-sales-status.routes";

const { hasPermission } = vi.hoisted(() => ({
  hasPermission: vi.fn(async (_user: string, _resource: string, _action: string) => true),
}));
vi.mock("../../../identity", () => ({ hasPermission }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

describe("sales status routes", () => {
  let server: http.Server;
  let base: string;
  const service = { change: vi.fn(), readProduct: vi.fn(), list: vi.fn() };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    for (const method of Object.values(service)) method.mockReset().mockResolvedValue({ ok: true });
    errors.mockClear();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: { user: { id: "operator-1" } }, configurable: true });
      next();
    });
    registerSalesStatusRoutes(app, service as never);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SALES_STATUS_API_BASE}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const change = () => fetch(`${base}/changes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes: [] }),
  });

  it("reads a product's sales status with view permission and no caching", async () => {
    const response = await fetch(`${base}/products/11`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledWith("operator-1", "inventory_planning", "view");
    expect(service.readProduct).toHaveBeenCalledWith("11");
  });

  it("lists settings with view permission, passing the query through for validation", async () => {
    expect((await fetch(`${base}/entries?status=stopped`)).status).toBe(200);
    expect(hasPermission).toHaveBeenCalledWith("operator-1", "inventory_planning", "view");
    expect(service.list).toHaveBeenCalledWith({ status: "stopped" });
  });

  it("requires activate for a change and passes only the session actor", async () => {
    expect((await change()).status).toBe(200);
    expect(hasPermission).toHaveBeenCalledWith("operator-1", "inventory_planning", "activate");
    expect(service.change).toHaveBeenCalledWith({ changes: [] }, "operator-1");
  });

  it("refuses a change without activate before the service runs", async () => {
    hasPermission.mockImplementation(async (_user: string, _resource: string, action: string) => action !== "activate");
    expect((await change()).status).toBe(403);
    expect(service.change).not.toHaveBeenCalled();
  });

  it("returns a stale view as a permanent conflict with the changed scopes", async () => {
    service.change.mockRejectedValue(new SalesStatusError(409, "SALES_STATUS_CHANGED", "Someone changed this sales status first.",
      "permanent", { conflicts: [{ scopeKey: "all:variant:22", expectedRevision: null, currentRevision: "4" }] }));
    const response = await change();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "SALES_STATUS_CHANGED",
      message: "Someone changed this sales status first.", retryable: false, details: ["all:variant:22"] } });
  });

  it("marks a busy refusal retryable and lists validation issues", async () => {
    service.change.mockRejectedValueOnce(new SalesStatusError(409, "SALES_STATUS_BUSY", "Retry.", "transient"));
    expect(await (await change()).json()).toMatchObject({ error: { code: "SALES_STATUS_BUSY", retryable: true, details: [] } });
    service.change.mockRejectedValueOnce(new SalesStatusError(400, "SALES_STATUS_INVALID_REQUEST", "Review it.", "permanent",
      { issues: ["changes: Array must contain at least 1 element(s)"] }));
    const invalid = await change();
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { details: ["changes: Array must contain at least 1 element(s)"] } });
  });

  it("reports an unrecognized failure as unconfirmed, never as a refusal, without leaking it", async () => {
    service.change.mockRejectedValue(Object.assign(new Error("connection terminated: secret detail"), { code: "ECONNRESET" }));
    const response = await change();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "SALES_STATUS_UNCONFIRMED",
      message: "The result is not confirmed. Retry the same change to read it.", retryable: true, details: [] } });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("\"error_code\":\"ECONNRESET\""));
  });
});
