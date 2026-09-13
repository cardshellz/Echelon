import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH,
  type InventoryRuntimeAuthorityReadout,
} from "@shared/types/inventory-runtime-authority";
import { registerInventoryRuntimeAuthorityRoutes } from "../../interfaces/http/inventory-runtime-authority.routes";
import { InventoryRuntimeAuthorityReadoutService } from "../../application/inventory-runtime-authority-readout.service";
import { InventoryRuntimeAuthorityReadoutError } from "../../domain/inventory-runtime-authority-readout";
import { logger } from "../../../../platform/observability/logger";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
// Keep the real requireAnyPermission middleware; isolate only its identity-owner call.
vi.mock("../../../identity", () => ({ hasPermission }));

const PATH = INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH;

function readout(): InventoryRuntimeAuthorityReadout {
  return {
    contractVersion: "inventory_runtime_authority_readout_v1",
    authority: "legacy",
    liveAllocator: "channel_allocation_rules",
    revision: "1",
    activationRunId: null,
    changedBy: "migration-0638",
    changeReason: "Initialize inactive inventory availability cutover authority.",
    changedAt: "2026-09-12T14:00:00.000Z",
  };
}

describe("inventory runtime authority routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let service: { read: ReturnType<typeof vi.fn> };
  let session: { user?: { id?: string } };
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    service = { read: vi.fn(async () => readout()) };
    session = { user: { id: "operator-1" } };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

  it("serves the readout to a channels viewer without consulting the second grant", async () => {
    const response = await request(server.url + PATH);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(readout());
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "channels", "view");
    expect(service.read).toHaveBeenCalledTimes(1);
  });

  it("serves the readout to an inventory-planning viewer who lacks the channels grant", async () => {
    hasPermission.mockImplementation(async (_user: string, resource: string) => resource === "inventory_planning");
    const response = await request(server.url + PATH);
    expect(response.status).toBe(200);
    expect(hasPermission.mock.calls).toEqual([
      ["operator-1", "channels", "view"],
      ["operator-1", "inventory_planning", "view"],
    ]);
  });

  it("rejects an unauthenticated session before any permission lookup or read", async () => {
    session = {};
    const response = await request(server.url + PATH);
    expect(response.status).toBe(401);
    expect(hasPermission).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
  });

  it("denies a viewer who holds neither grant", async () => {
    hasPermission.mockResolvedValue(false);
    const response = await request(server.url + PATH);
    expect(response.status).toBe(403);
    expect(hasPermission).toHaveBeenCalledTimes(2);
    expect(service.read).not.toHaveBeenCalled();
  });

  it.each(["?activate=true", "?authority=canonical", "?revision=2"])("rejects query injection %s", async (query) => {
    const response = await request(server.url + PATH + query);
    expect(response).toMatchObject({ status: 400, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_INVALID_REQUEST" } } });
    expect(service.read).not.toHaveBeenCalled();
  });

  it("rejects a GET command body", async () => {
    const response = await request(server.url + PATH, { body: { authority: "canonical" } });
    expect(response).toMatchObject({ status: 400, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_INVALID_REQUEST" } } });
    expect(service.read).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not register a mutating %s endpoint", async (method) => {
    expect((await request(server.url + PATH, { method, body: { authority: "canonical" } })).status).toBe(404);
    expect(service.read).not.toHaveBeenCalled();
  });

  it("returns a transient 503 for a store read failure and keeps the cause in the log only", async () => {
    service.read.mockRejectedValue(new InventoryRuntimeAuthorityReadoutError(
      503, "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED", "The inventory runtime authority could not be read.",
      "transient", { cause: "connection to db-private refused" },
    ));
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 503, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toContain("db-private");
    expect(warnSpy).toHaveBeenCalledWith("inventory_runtime_authority_read", expect.objectContaining({
      outcome: "failed", error_code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED", error_class: "transient",
      context: { cause: "connection to db-private refused" },
    }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns a permanent 503 for an invalid singleton and logs it at error level", async () => {
    service.read.mockRejectedValue(new InventoryRuntimeAuthorityReadoutError(
      503, "INVENTORY_RUNTIME_AUTHORITY_INVALID", "The persisted inventory runtime authority does not satisfy its contract.",
      "permanent", { issues: [{ path: "activationRunId", message: "lineage" }] },
    ));
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 503, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_INVALID" } } });
    expect(errorSpy).toHaveBeenCalledWith("inventory_runtime_authority_read", expect.objectContaining({
      error_code: "INVENTORY_RUNTIME_AUTHORITY_INVALID", error_class: "permanent",
    }));
  });

  it.each([
    { liveAllocator: "inventory_exposure" },
    { authority: "shadow" },
    { secret: "private" },
    { revision: "0" },
  ])("refuses malformed service output %j instead of showing it to an operator", async (patch) => {
    service.read.mockResolvedValue({ ...readout(), ...patch });
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(response.body).not.toHaveProperty("authority");
  });

  it("sanitizes an untyped failure", async () => {
    service.read.mockRejectedValue(new Error("password=hunter2"));
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("hunter2");
  });

  it("serves a canonical readout through the real service and a read-only store", async () => {
    const store = { read: vi.fn(async () => [{
      authority: "canonical", revision: "7", activationRunId: "42",
      changedBy: "operator-9", changeReason: "Cutover commit.", changedAt: "2026-09-12T14:00:00.000Z",
    }]) };
    const actual = new InventoryRuntimeAuthorityReadoutService(store);
    service.read.mockImplementation(() => actual.read());
    const response = await request(server.url + PATH);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authority: "canonical", liveAllocator: "inventory_exposure", revision: "7", activationRunId: "42" });
    expect(store.read).toHaveBeenCalledTimes(1);
  });
});

async function startServer(service: Pick<InventoryRuntimeAuthorityReadoutService, "read">, session: () => unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerInventoryRuntimeAuthorityRoutes(app, service);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function request(url: string, init: { method?: string; body?: unknown } = {}) {
  const target = new URL(url); const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: init.method ?? "GET", headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8");
        const json = res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) as Record<string, unknown> : {};
        resolve({ status: res.statusCode ?? 0, body: json, headers: res.headers }); });
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
