import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WorkConfigurationService } from "../../work/application/work-configuration.service";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { registerWorkConfigurationRoutes } from "../../work/interfaces/work-configuration.routes";
import { WarehouseWorkError } from "../../work/domain/work-configuration";
import type { Pool } from "pg";
import { emptyWorkConfiguration } from "@shared/warehouse-work";

describe("warehouse work HTTP boundary", () => {
  let server: Server;
  let base: string;
  let authenticated: boolean;
  let service: WorkConfigurationService;
  beforeEach(async () => {
    authenticated = true;
    service = new WorkConfigurationService(new WorkConfigurationRepository({} as Pool), () => new Date("2026-09-05T12:00:00Z"));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { user: authenticated ? { id: "session-user" } : undefined } as Request["session"];
      next();
    });
    registerWorkConfigurationRoutes(app, service);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/warehouses`;
  });
  afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  it.each([["GET", ""], ["PUT", ""], ["GET", "/history"], ["POST", "/preview-context"]])("requires authentication for %s %s", async (method, suffix) => {
    authenticated = false;
    const result = await fetch(`${base}/1/work-configuration${suffix}`, { method });
    expect(result.status).toBe(401);
  });
  it.each(["1junk", "0", "-1", "2147483648"])("rejects non-canonical warehouse ID %s", async (id) => {
    const setup = vi.spyOn(service, "setup");
    expect((await fetch(`${base}/${id}/work-configuration`)).status).toBe(400);
    expect(setup).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor, not a request actor", async () => {
    const save = vi.spyOn(service, "save").mockResolvedValue({ warehouseId: 1, revision: 1, configuration: emptyWorkConfiguration(), executionStatus: "not_connected", savedAt: null, savedBy: "session-user", reason: "draft" });
    const body = { forgedActor: "another-person" };
    const result = await fetch(`${base}/1/work-configuration`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(result.status).toBe(200);
    expect(save).toHaveBeenCalledWith("session-user", 1, body);
  });
  it("returns classified permission and conflict failures without hiding them as success", async () => {
    vi.spyOn(service, "setup").mockRejectedValue(new WarehouseWorkError("WORK_PERMISSION_DENIED", "Denied", 403));
    const result = await fetch(`${base}/1/work-configuration`);
    expect(result.status).toBe(403); expect(await result.json()).toMatchObject({ code: "WORK_PERMISSION_DENIED" });
  });
  it("does not leak database error details and classifies retryable failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const setup = vi.spyOn(service, "setup").mockRejectedValue(Object.assign(new Error("sensitive database detail"), { code: "40P01" }));
    let result = await fetch(`${base}/1/work-configuration`);
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ code: "WORK_RETRY_REQUIRED" });
    setup.mockRejectedValue(new Error("sensitive database detail"));
    result = await fetch(`${base}/1/work-configuration`);
    expect(result.status).toBe(500); expect(await result.text()).not.toContain("sensitive");
  });
});
