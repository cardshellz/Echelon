import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { hasAssignedSystemRole, type CurrentStaffAccess } from "../../modules/identity/domain/staff-access";
const { readCurrentStaffAccess, hasPermission } = vi.hoisted(() => ({ readCurrentStaffAccess: vi.fn(), hasPermission: vi.fn() }));
vi.mock("../../modules/identity", () => ({ readCurrentStaffAccess, hasAssignedSystemRole, hasPermission }));
import { requireAuth, requireActiveSessionIdentity, requirePermission, requireAnyPermission,
  requireAssignedSystemRole, requireAuthOrInternalApiKey, requireInternalApiKey } from "../../routes/middleware";

const user = { id: "employee", username: "Employee", role: "admin", displayName: null,
  active: 1, createdAt: new Date(), lastLoginAt: null };
const custom = { id: 9, name: "Custom role", isSystem: false };
const snapshot = (roles = [custom], permissions: string[] = []): CurrentStaffAccess => ({ user, roles, permissions });
const request = (signedIn = true) => ({ session: { user: signedIn ? user : undefined }, headers: {} }) as Request;
function response() { const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res; }
beforeEach(() => { vi.unstubAllEnvs(); readCurrentStaffAccess.mockReset(); hasPermission.mockReset(); });

describe("staff HTTP guards use current Identity authority", () => {
  it("denies a session for an inactive/deleted identity and never queries for an absent session", async () => {
    for (const signedIn of [false, true]) {
      readCurrentStaffAccess.mockResolvedValue(undefined);
      const res = response(); const next = vi.fn();
      await requireAuth(request(signedIn), res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
    }
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(1);
  });
  it("zero roles authenticate for account status only, never operational access", async () => {
    readCurrentStaffAccess.mockResolvedValue(snapshot([]));
    const res = response(); const next = vi.fn();
    await requireAuth(request(), res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
    await requireActiveSessionIdentity(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
  it("custom roles are real operational assignments and permissions remain explicit", async () => {
    readCurrentStaffAccess.mockResolvedValue(snapshot([custom], ["inventory:view"]));
    hasPermission.mockImplementation(async (_user, resource, action) => resource === "inventory" && action === "view");
    const req = request(); const res = response(); const next = vi.fn();
    await requireAuth(req, res as unknown as Response, next);
    await requirePermission("inventory", "view")(req, res as unknown as Response, next);
    await requireAnyPermission(["orders", "view"], ["inventory", "view"])(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(3); expect(readCurrentStaffAccess).toHaveBeenCalledOnce();
    expect(hasPermission).toHaveBeenCalledTimes(3);
    await requirePermission("users", "edit")(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it("a new request rechecks revocation rather than reusing prior request or session role", async () => {
    readCurrentStaffAccess.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([]));
    const next = vi.fn(); const res = response();
    await requireAuth(request(), res as unknown as Response, next);
    await requireAuth(request(), res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce(); expect(res.status).toHaveBeenCalledWith(403);
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(2);
  });
  it("system-role guard ignores saved admin labels and custom same-name roles", async () => {
    const guard = requireAssignedSystemRole("admin", "lead");
    for (const role of [custom, { id: 3, name: "Administrator", isSystem: false }]) {
      readCurrentStaffAccess.mockResolvedValue(snapshot([role]));
      const res = response(); const next = vi.fn();
      await guard(request(), res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
    }
    readCurrentStaffAccess.mockResolvedValue(snapshot([{ id: 2, name: "Team Lead", isSystem: true }]));
    const next = vi.fn(); await guard(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
  it("forwards authority failures without granting or reporting a successful empty permission set", async () => {
    const error = new Error("database unavailable"); readCurrentStaffAccess.mockRejectedValue(error);
    hasPermission.mockRejectedValue(error);
    for (const guard of [requireAuth, requireActiveSessionIdentity, requirePermission("inventory", "view"), requireAssignedSystemRole("admin")]) {
      const next = vi.fn(); const res = response();
      await guard(request(), res as unknown as Response, next);
      expect(next).toHaveBeenCalledWith(error); expect(res.json).not.toHaveBeenCalled();
    }
  });
  it("preserves capability deny status and delegates each request to the current permission owner", async () => {
    hasPermission.mockResolvedValue(false);
    for (const guard of [requirePermission("users", "edit"), requireAnyPermission(["users", "edit"])]) {
      const next = vi.fn(); const res = response();
      await guard(request(), res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
    }
    expect(hasPermission).toHaveBeenCalledTimes(2);
    expect(readCurrentStaffAccess).not.toHaveBeenCalled();
  });
  it("preserves explicit internal API-key authority while rechecking the staff alternative", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "synthetic-service-key");
    const req = request(false); req.headers.authorization = "Bearer synthetic-service-key";
    const next = vi.fn();
    await requireAuthOrInternalApiKey(req, response() as unknown as Response, next);
    requireInternalApiKey(req, response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(2); expect(readCurrentStaffAccess).not.toHaveBeenCalled();
    readCurrentStaffAccess.mockResolvedValue(snapshot([]));
    const res = response(); await requireAuthOrInternalApiKey(request(), res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).toHaveBeenCalledTimes(2);
  });
});
