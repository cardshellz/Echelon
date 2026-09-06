import express, { type Request } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAssemblyWorkRoutes } from "../../work/interfaces/assembly-work.routes";
import { WarehouseWorkError } from "../../work/domain/work-configuration";
import { task, start, fence } from "../assembly-work.fixture";

describe("assembly work HTTP validation and identity", () => {
  let server: Server; let base: string; let authenticated: boolean;
  const service = { queue: vi.fn(), get: vi.fn(), command: vi.fn(), handoff: vi.fn(), complete: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks(); authenticated = true;
    service.queue.mockResolvedValue({ tasks: [], nextBeforeId: null });
    service.get.mockResolvedValue(task());
    service.command.mockResolvedValue({ task: task(), idempotentReplay: false });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: authenticated ? { id: "session-user" } : undefined } as Request["session"]; next(); });
    registerAssemblyWorkRoutes(app, { assemblyWork: service });
    server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/warehouse/assembly-work`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  async function post(path: string, body: unknown) {
    return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  it.each([["GET", "?warehouseId=1"], ["GET", "/1"], ["POST", "/1/commands"], ["POST", "/handoffs"], ["POST", "/1/complete"]])("requires authentication for %s %s", async (method, path) => {
    authenticated = false;
    expect((await fetch(`${base}${path}`, { method })).status).toBe(401);
  });
  it.each(["0", "1junk", "1e2", "-1", "2147483648"])("rejects malformed warehouse ID %s before application execution", async (warehouseId) => {
    expect((await fetch(`${base}?warehouseId=${warehouseId}`)).status).toBe(400);
    expect(service.queue).not.toHaveBeenCalled();
  });
  it("bounds queue queries and rejects invalid cursor and truthy-string coercion", async () => {
    for (const query of ["limit=101", "limit=0", "beforeId=foo", "beforeId=9223372036854775808", "includeClosed=yes"]) {
      expect((await fetch(`${base}?warehouseId=1&${query}`)).status).toBe(400);
    }
    expect(service.queue).not.toHaveBeenCalled();
  });
  it("uses the session actor and rejects attempted actor injection", async () => {
    expect((await post("/1/commands", start())).status).toBe(200);
    expect(service.command).toHaveBeenCalledWith("session-user", "1", start());
    service.command.mockClear();
    expect((await post("/1/commands", { ...start(), actor: "admin" })).status).toBe(400);
    expect(service.command).not.toHaveBeenCalled();
  });
  it("rejects completion without explicit physical confirmation", async () => {
    expect((await post("/1/complete", { commandId: start().commandId, reason: "Complete", fence: { ...fence(), confirmPhysicalAssembly: false } })).status).toBe(400);
    expect(service.complete).not.toHaveBeenCalled();
  });
  it("does not report invalid persisted/output data as a client validation error", async () => {
    service.get.mockResolvedValue({ wrong: "contract" });
    const response = await fetch(`${base}/1`);
    expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ code: "WORK_REQUEST_FAILED" });
  });
  it("returns scoped permission and recovery conflicts as actionable failures", async () => {
    service.get.mockRejectedValue(new WarehouseWorkError("WORK_SCOPE_DENIED", "Outside your work area", 403));
    expect((await fetch(`${base}/1`)).status).toBe(403);
    service.command.mockRejectedValue(new WarehouseWorkError("WORK_PHYSICAL_RECOVERY_REQUIRED", "Physical recovery required", 409));
    const response = await post("/1/commands", start());
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "WORK_PHYSICAL_RECOVERY_REQUIRED" });
  });
  it("classifies contention and hides unexpected database error details", async () => {
    service.get.mockRejectedValue(Object.assign(new Error("private SQL detail"), { code: "40P01" }));
    let response = await fetch(`${base}/1`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private SQL");
    service.get.mockRejectedValue(new Error("private connection credentials"));
    response = await fetch(`${base}/1`);
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("credentials");
  });
});
