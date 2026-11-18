import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, RequestHandler, Response } from "express";
const {readCurrentStaffAccess,readStaffCredentialState}=vi.hoisted(()=>({readCurrentStaffAccess:vi.fn(),readStaffCredentialState:vi.fn()}));
vi.mock("../../infrastructure/staff-access.repository",()=>({readCurrentStaffAccess}));
vi.mock("../../infrastructure/staff-credentials.repository",()=>({readStaffCredentialState}));
vi.mock("../../application/staff-credentials",()=>({}));
vi.mock("../..", async () => ({ readCurrentStaffAccess,
  hasAssignedSystemRole: (await import("../../domain/staff-access")).hasAssignedSystemRole }));
vi.mock("../../infrastructure/identity.repository", () => ({}));
vi.mock("../../application/identity.use-cases", () => ({}));
import { registerAuthRoutes } from "../../identity.routes";

const user = { id: "staff", username: "Current name", role: "picker", displayName: null,
  active: 1, createdAt: new Date(), lastLoginAt: null };
const routes = new Map<string, RequestHandler[]>();
const app = Object.fromEntries(["get", "post", "patch", "put", "delete"].map(method =>
  [method, (path: string, ...handlers: RequestHandler[]) => { routes.set(`${method} ${path}`, handlers); }])) as unknown as Express;
registerAuthRoutes(app);
async function authMe() {
  const req = { session: { staffCredentialVersion:"a760c267-283a-43bd-9bfb-c8a6d1048033", user: { ...user, username: "Stale saved name", role: "admin" } } } as Request;
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const errors: unknown[] = [];
  for (const handler of routes.get("get /api/auth/me")!) {
    let proceed = false;
    await handler(req, res as unknown as Response, error => { if (error) errors.push(error); else proceed = true; });
    if (!proceed) break;
  }
  return { res, errors };
}
beforeEach(() => {readCurrentStaffAccess.mockReset();readStaffCredentialState.mockReset().mockResolvedValue({credentialVersion:"a760c267-283a-43bd-9bfb-c8a6d1048033",mustChangePassword:false});});

describe("auth/me returns one current authority snapshot", () => {
  it("returns current identity plus backward-compatible names and explicit assignment metadata", async () => {
    const roles = [{ id: 2, name: "Team Lead", isSystem: true }, { id: 9, name: "Cost reviewer", isSystem: false }];
    readCurrentStaffAccess.mockResolvedValue({ user, roles, permissions: ["purchasing:view"] });
    const { res } = await authMe();
    expect(res.json).toHaveBeenCalledWith({ user, permissions: ["purchasing:view"],
      roles: ["Team Lead", "Cost reviewer"], assignedRoles: roles, systemRoles: ["lead"],credentialActionRequired:false });
    expect(readCurrentStaffAccess).toHaveBeenCalledOnce();
  });
  it("shows intentional no-access identity instead of logging out or reviving its old admin label", async () => {
    readCurrentStaffAccess.mockResolvedValue({ user, roles: [], permissions: [] });
    const { res } = await authMe();
    expect(res.json).toHaveBeenCalledWith({ user, roles: [], permissions: [], assignedRoles: [], systemRoles: [],credentialActionRequired:false });
  });
  it("rejects stale session identity and exposes authority failure to error handling", async () => {
    readCurrentStaffAccess.mockResolvedValueOnce(undefined);
    expect((await authMe()).res.status).toHaveBeenCalledWith(401);
    const error = new Error("synthetic database failure"); readCurrentStaffAccess.mockRejectedValueOnce(error);
    const failed = await authMe(); expect(failed.errors).toEqual([error]);
    expect(failed.res.json).not.toHaveBeenCalled();
  });
});
