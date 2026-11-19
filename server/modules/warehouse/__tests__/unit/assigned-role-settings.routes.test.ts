import express, { type Request } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import type { CurrentStaffAccess } from "../../../identity/staff-authority";

const state = vi.hoisted(() => ({ readCurrentStaffAccess: vi.fn(), createAdjustmentReason: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: { createAdjustmentReason: state.createAdjustmentReason } }));
vi.mock("../../../identity", async () => {
  const actual = await import("../../../identity/staff-authority");
  return {
    readCurrentStaffAccess: state.readCurrentStaffAccess,
    hasAssignedSystemRole: actual.hasAssignedSystemRole,
    hasPermission: vi.fn(async (userId: string, resource: string, action: string) => {
      const access = await state.readCurrentStaffAccess(userId);
      return Boolean(access && access.roles.length > 0 && access.permissions.includes(`${resource}:${action}`));
    }),
  };
});
import { registerSettingsRoutes } from "../../settings.routes";

const current: CurrentStaffAccess = {
  user: { id: "operator", username: "synthetic", displayName: null, role: "picker", active: 1,
    createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null },
  roles: [{ id: 9, name: "Warehouse Configurator", isSystem: false }], permissions: ["warehouse:manage"],
};

describe("adjustment reason HTTP warehouse:manage capability boundary", () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    state.readCurrentStaffAccess.mockResolvedValue(current);
    state.createAdjustmentReason.mockResolvedValue({ id: 1, code: "SYNTHETIC" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { ...current.user, role: "admin" } } as Request["session"]; next(); });
    registerSettingsRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory/adjustment-reasons`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([
    { name: "zero assigned roles", roles: [], permissions: ["warehouse:manage"] },
    { name: "assigned Administrator without warehouse:manage", roles: [{ id: 1, name: "Administrator", isSystem: true }], permissions: [] },
    { name: "assigned Team Lead without warehouse:manage", roles: [{ id: 2, name: "Team Lead", isSystem: true }], permissions: ["warehouse:read"] },
  ])("denies $name despite cached legacy admin before the writer", async ({ roles, permissions }) => {
    state.readCurrentStaffAccess.mockResolvedValue({ ...current, roles, permissions });
    const response = await requestLocalHttp(url, { method: "POST" });
    expect(response.status).toBe(403);
    expect(state.createAdjustmentReason).not.toHaveBeenCalled();
  });

  it("permits a custom role with warehouse:manage then denies the same session after capability revocation", async () => {
    const allowed = await requestLocalHttp(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "SYNTHETIC" }) });
    expect(allowed.status).toBe(201);
    expect(state.createAdjustmentReason).toHaveBeenCalledOnce();
    expect(state.createAdjustmentReason).toHaveBeenCalledWith({ code: "SYNTHETIC" });
    state.readCurrentStaffAccess.mockResolvedValue({ ...current, permissions: [] });
    expect((await requestLocalHttp(url, { method: "POST" })).status).toBe(403);
    expect(state.createAdjustmentReason).toHaveBeenCalledTimes(1);
    expect(state.readCurrentStaffAccess.mock.calls).toEqual([["operator"], ["operator"]]);
  });
});
