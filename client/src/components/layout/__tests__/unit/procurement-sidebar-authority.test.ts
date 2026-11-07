import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "../../AppShell";

const identity = vi.hoisted(() => ({
  role: "picker",
  permissions: [] as string[],
  assignedRoles: [] as Array<{ id: number; name: string; isSystem: boolean }>,
  systemRoles: [] as Array<"admin" | "lead" | "picker">,
  logout: vi.fn<() => Promise<void>>(),
  logoutActions: [] as Array<() => Promise<void>>,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "sidebar-operator", username: "sidebar-operator", displayName: "Sidebar Operator", role: identity.role },
    assignedRoles: identity.assignedRoles,
    hasSystemRole: (role: "admin" | "lead" | "picker") => identity.systemRoles.includes(role),
    hasPermission: (resource: string, action: string) => identity.permissions.includes(resource + ":" + action),
    logout: identity.logout,
  }),
}));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/page-data-health", () => ({ PageDataHealth: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => {
  // Render menu contents so the test observes access conditions, not Radix's
  // closed-menu portal lifecycle. Browser keyboard/portal behavior is separate.
  const part = ({ children, onClick, "data-testid": testId }: { children?: ReactNode; onClick?: () => Promise<void>; "data-testid"?: string }) => {
    if (children === "Log out" && onClick) identity.logoutActions.push(onClick);
    return createElement("div", { "data-testid": testId }, children);
  };
  return { DropdownMenu: part, DropdownMenuContent: part, DropdownMenuItem: part,
    DropdownMenuLabel: part, DropdownMenuSeparator: part, DropdownMenuTrigger: part };
});

function renderAt(path: string): string {
  const url = new URL(path, "https://echelon.test");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
      createElement(Router, {
        ssrPath: url.pathname,
        ssrSearch: url.search,
        children: createElement(Layout, { children: createElement("main", null, "Connected procurement") }),
      })));
  } finally { queryClient.clear(); }
}
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map(match => match[1].replace(/&amp;/g, "&"));
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.logout.mockResolvedValue(undefined);
  identity.logoutActions = [];
  identity.role = "picker";
  identity.assignedRoles = [{ id: 901, name: "Receipt operator", isSystem: false }];
  identity.systemRoles = [];
  identity.permissions = ["inventory:view", "inventory:adjust", "purchasing:view",
    "inventory_planning:view", "orders:edit", "dropship:manage_operations"];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("procurement sidebar grant boundaries", () => {
  it("requires picking:view for Picking navigation and hides non-live Packing", () => {
    identity.permissions = [];
    expect(hrefs(renderAt("/picking"))).not.toContain("/picking");
    expect(hrefs(renderAt("/picking"))).not.toContain("/packing");
    identity.permissions = ["picking:view"];
    expect(hrefs(renderAt("/picking"))).toContain("/picking");
    expect(hrefs(renderAt("/picking"))).not.toContain("/packing");
    identity.assignedRoles = [];
    expect(hrefs(renderAt("/picking"))).not.toContain("/picking");
  });
  it("uses the dashboard's inventory read grant rather than a system-role fallback", () => {
    expect(hrefs(renderAt("/"))).toContain("/");
    identity.role = "picker";
    identity.assignedRoles = [{ id: 1, name: "Administrator", isSystem: true }];
    identity.systemRoles = ["admin"];
    identity.permissions = [];
    expect(hrefs(renderAt("/"))).not.toContain("/");
  });
  it.each([
    ["/inventory/cutover", "/inventory/cutover"],
    ["/order-edits", "/order-edits"],
    ["/channels/inventory", "/channels/inventory"],
    ["/dropship?tab=finance", "/dropship?tab=finance"],
  ])("preserves the existing named-grant access to %s", (path, href) => {
    // Existing child grants override the parent's system-role fallback. Render
    // the active group so collapsed markup cannot hide an access regression.
    expect(hrefs(renderAt(path))).toContain(href);
    identity.permissions = ["purchasing:view"];
    expect(hrefs(renderAt(path))).not.toContain(href);
  });

  it("admits explicitly granted procurement children for a custom role regardless of its legacy label", () => {
    const procurementLinks = hrefs(renderAt("/receiving"));
    expect(procurementLinks).toEqual(expect.arrayContaining(["/receiving", "/purchase-orders", "/shipments"]));
    expect(procurementLinks).toContain("/demand-planner");
    const payableLinks = hrefs(renderAt("/ap-invoices"));
    expect(payableLinks).toEqual(expect.arrayContaining([
      "/ap", "/ap-invoices", "/ap-payments", "/supplier-credits", "/supplier-returns",
    ]));
  });

  it("does not admit procurement children using unrelated named grants", () => {
    identity.permissions = ["inventory_planning:view", "orders:edit", "dropship:manage_operations"];
    expect(hrefs(renderAt("/receiving"))).not.toContain("/receiving");
    expect(hrefs(renderAt("/ap-invoices"))).not.toContain("/ap-invoices");
  });

  it("requires both inventory and purchasing reads for the combined dashboard", () => {
    expect(hrefs(renderAt("/purchasing"))).toContain("/purchasing");
    identity.permissions = ["purchasing:view"];
    expect(hrefs(renderAt("/purchasing"))).not.toContain("/purchasing");
    identity.role = "lead";
    identity.permissions = ["inventory:view"];
    expect(hrefs(renderAt("/purchasing"))).not.toContain("/purchasing");
  });

  it("preserves assigned system-role inheritance for children without an established permission", () => {
    expect(hrefs(renderAt("/vendors"))).not.toContain("/vendors");
    identity.role = "lead";
    expect(hrefs(renderAt("/vendors"))).not.toContain("/vendors");
    identity.assignedRoles = [{ id: 2, name: "Team Lead", isSystem: true }];
    identity.systemRoles = ["lead"];
    expect(hrefs(renderAt("/vendors"))).toContain("/vendors");
    expect(hrefs(renderAt("/inventory/history"))).not.toContain("/inventory/history");
    identity.role = "admin";
    expect(hrefs(renderAt("/inventory/history"))).not.toContain("/inventory/history");
    identity.assignedRoles = [{ id: 1, name: "Administrator", isSystem: true }];
    identity.systemRoles = ["admin"];
    expect(hrefs(renderAt("/inventory/history"))).toContain("/inventory/history");
  });

  it("does not infer system authority from a custom role's display name", () => {
    identity.role = "admin";
    identity.assignedRoles = [{ id: 902, name: "Administrator", isSystem: false }];
    expect(hrefs(renderAt("/inventory/history"))).not.toContain("/inventory/history");
    expect(hrefs(renderAt("/vendors"))).not.toContain("/vendors");
    expect(hrefs(renderAt("/inventory"))).toContain("/inventory");
  });

  it("renders no operational links with zero assignments even if stale permission strings remain", () => {
    identity.role = "admin";
    identity.assignedRoles = [];
    identity.systemRoles = ["admin"];
    const html = renderAt("/inventory");
    const links=hrefs(html);
    expect(links.filter(href=>href!=="/staff/password")).toEqual([]);
    expect(links).toContain("/staff/password");
    expect(html).toContain("No assigned roles");
    expect(html).not.toContain("button-settings-menu");
  });

  it("renders actual assigned names as escaped text rather than the compatibility label", () => {
    identity.role = "admin";
    identity.assignedRoles = [{ id: 903, name: "Custom <warehouse>", isSystem: false }];
    const html = renderAt("/inventory");
    expect(html).toContain("Custom &lt;warehouse&gt;");
    expect(html).not.toContain(">admin</span>");
  });

  it("uses individual header permissions without a legacy admin fallback", () => {
    identity.permissions = ["users:view", "roles:view"];
    const links = hrefs(renderAt("/users"));
    expect(links).toContain("/users");
    expect(links).toContain("/roles");
    expect(links).not.toContain("/settings");
    expect(links).not.toContain("/integrations");
    identity.permissions = [];
    identity.role = "admin";
    expect(hrefs(renderAt("/users"))).not.toContain("/users");
    expect(hrefs(renderAt("/roles"))).not.toContain("/roles");
  });

  it("uses existing read capabilities for navigation and does not borrow unrelated grants", () => {
    identity.permissions = ["inventory:view", "channels:view", "settings:view", "warehouse_work:assembly"];
    expect(hrefs(renderAt("/inventory"))).toContain("/inventory/costs");
    expect(hrefs(renderAt("/channels"))).toEqual(expect.arrayContaining(["/channels", "/channel-allocation", "/sync-log"]));
    expect(hrefs(renderAt("/channels"))).not.toContain("/subscriptions");
    expect(hrefs(renderAt("/pick-priority"))).toEqual(expect.arrayContaining(["/pick-priority", "/assembly"]));
    identity.permissions = ["shellz:admin"];
    expect(hrefs(renderAt("/subscriptions"))).toContain("/subscriptions");
    expect(hrefs(renderAt("/subscriptions"))).not.toContain("/channels");
  });

  it.each([false, true])("navigates away only after verified logout (rejected=%s)", async rejected => {
    renderAt("/inventory");
    const location = { href: "/inventory" };
    vi.stubGlobal("window", { location });
    if (rejected) identity.logout.mockRejectedValue(new Error("Session destruction failed"));
    expect(identity.logoutActions).toHaveLength(1);
    await expect(identity.logoutActions[0]()).resolves.toBeUndefined();
    expect(identity.logout).toHaveBeenCalledOnce();
    expect(location.href).toBe(rejected ? "/inventory" : "/login");
  });
});
