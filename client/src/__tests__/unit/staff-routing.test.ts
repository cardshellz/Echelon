import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router as WouterRouter } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  // Existing Vitest uses classic JSX, including top-level elements in pages.
  vi.stubGlobal("React", actual);
  return actual;
});

const fixture = vi.hoisted(() => ({ permissions: [] as string[], systemRoles: [] as string[],
  assignedRoles: [] as Array<{ id: number; name: string; isSystem: boolean }>,
  accessStatus: "authenticated", layout: vi.fn(), walmart: vi.fn(), role: "admin" }));
vi.mock("@/lib/auth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ user: { id: "staff", role: fixture.role }, isLoading: false, accessStatus: fixture.accessStatus,
    assignedRoles: fixture.assignedRoles, roles: fixture.assignedRoles.map(role => role.name), permissions: fixture.permissions,
    hasPermission: (resource: string, action: string) => fixture.permissions.includes(`${resource}:${action}`),
    hasSystemRole: (role: string) => fixture.systemRoles.includes(role), accessError: null,
    refetch: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/settings", () => ({ SettingsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/dropship-auth", () => ({
  isDropshipPortalHost: () => false, dropshipPortalPath: (path: string) => path,
  DropshipAuthProvider: ({ children }: { children: ReactNode }) => children, useDropshipAuth: () => ({ isAuthenticated: false }),
}));
vi.mock("@/components/PWAUpdatePrompt", () => ({ PWAUpdatePrompt: () => null }));
vi.mock("@/components/layout/AppShell", () => ({ default: ({ children }: { children: ReactNode }) => {
  fixture.layout(); return createElement("section", { "data-testid": "operational-shell" }, children);
} }));
vi.mock("@/pages/WalmartChannelPage", () => ({ default: () => null, WalmartChannelRouteHost: () => { fixture.walmart(); return null; } }));
vi.mock("@/pages/Users", () => ({ default: () => createElement("p", null, "Users surface") }));
vi.mock("@/pages/Roles", () => ({ default: () => createElement("p", null, "Roles surface") }));
vi.mock("@/pages/Orders", () => ({ default: () => createElement("p", null, "Orders surface") }));
vi.mock("@/pages/Dashboard", () => ({ default: () => createElement("p", null, "Dashboard surface") }));
vi.mock("@/pages/PickingPage", () => ({ default: () => createElement("p", null, "Picking surface") }));
vi.mock("@/pages/Packing", () => ({ default: () => createElement("p", null, "Non-live packing surface") }));
vi.mock("@/pages/Inventory", () => ({ default: () => createElement("p", null, "Inventory surface") }));
vi.mock("@/pages/Login", () => ({ default: () => createElement("p", null, "Login surface") }));
// Public return page styling/builds are outside this staff-router unit boundary.
vi.mock("@/pages/CustomerReturnPortalPreview", () => ({ default: () => null }));
vi.mock("@/pages/CustomerReturnCustomerPortal", () => ({ default: () => null }));
vi.mock("@/pages/CustomerReturnPortalAccess", () => ({ default: () => null }));
vi.mock("@/components/returns/CustomerReturnSurface", async () => {
  const react = await import("react");
  return { CustomerReturnEmbeddedContext: react.createContext(false), CustomerReturnSurface: () => null };
});
import App from "../../App";

function renderAt(path: string) {
  return renderToStaticMarkup(createElement(WouterRouter, { ssrPath: path, children: createElement(App) }));
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.permissions = []; fixture.systemRoles = []; fixture.assignedRoles = [];
  fixture.accessStatus = "authenticated"; fixture.role = "admin";
});
describe("staff router authority before operational surfaces", () => {
  it.each(["/", "/users", "/packing", "/picking", "/channels/walmart/1"])("does not mount operational work for zero roles at %s", path => {
    const html = renderAt(path);
    expect(html).toContain("You have no assigned roles");
    expect(html).toContain("Sign out");
    expect(fixture.layout).not.toHaveBeenCalled();
    expect(fixture.walmart).not.toHaveBeenCalled();
  });
  it("blocks unverified metadata before an operational shell even if a user remains", () => {
    fixture.accessStatus = "unverified";
    expect(renderAt("/users")).toContain("Access verification unavailable");
    expect(fixture.layout).not.toHaveBeenCalled();
  });
  it("allows a custom user-reader despite the legacy picker label", () => {
    fixture.role = "picker"; fixture.assignedRoles = [{ id: 99, name: "User reader", isSystem: false }];
    fixture.permissions = ["users:view"];
    expect(renderAt("/users")).toContain("Users surface");
  });
  it("does not treat a legacy admin label as permission to view users", () => {
    fixture.assignedRoles = [{ id: 99, name: "Stock reader", isSystem: false }];
    fixture.permissions = ["inventory:view"];
    expect(renderAt("/users")).not.toContain("Users surface");
    expect(renderAt("/users")).toContain("assigned roles do not provide access to this page");
  });
  it("keeps an unresolved legacy-only page restricted to explicitly assigned system roles", () => {
    fixture.assignedRoles = [{ id: 99, name: "Custom order reader", isSystem: false }]; fixture.permissions = ["orders:view"];
    expect(renderAt("/orders")).not.toContain("Orders surface");
    fixture.assignedRoles = [{ id: 1, name: "Team Lead", isSystem: true }]; fixture.systemRoles = ["lead"]; fixture.role = "picker";
    expect(renderAt("/orders")).toContain("Orders surface");
  });
  it("allows Dashboard via its established read permission, independently of the compatibility label", () => {
    fixture.assignedRoles = [{ id: 99, name: "Inventory reader", isSystem: false }]; fixture.permissions = ["inventory:view"]; fixture.role = "picker";
    expect(renderAt("/")).toContain("Dashboard surface");
  });
  it.each([
    ["/picking", "picking:view"],
    ["/picking/logs", "picking:view_logs"],
    ["/picking/metrics", "picking:view_metrics"],
    ["/picking/settings", "picking:manage_settings"],
  ])("gates %s on its explicit capability (%s) rather than assigned system-role membership", (path, grant) => {
    fixture.assignedRoles = [{ id: 3, name: "Picker", isSystem: true }];
    fixture.systemRoles = ["picker", "lead", "admin"];
    fixture.permissions = [];
    expect(renderAt(path)).not.toContain("Picking surface");
    expect(renderAt(path)).toContain("assigned roles do not provide access to this page");
    fixture.systemRoles = [];
    fixture.assignedRoles = [{ id: 99, name: "Custom picking role", isSystem: false }];
    fixture.permissions = [grant];
    expect(renderAt(path)).toContain("Picking surface");
  });
  it("denies non-live /packing even when a staff member has assigned roles and picking permissions", () => {
    fixture.assignedRoles = [{ id: 3, name: "Picker", isSystem: true }];
    fixture.systemRoles = ["picker", "admin"];
    fixture.permissions = ["picking:view", "picking:perform", "picking:complete"];
    const html = renderAt("/packing");
    expect(html).not.toContain("Non-live packing surface");
    expect(html).toContain("assigned roles do not provide access to this page");
  });
});
