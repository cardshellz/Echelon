import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "../../AppShell";

const identity = vi.hoisted(() => ({ role: "picker", permissions: [] as string[] }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "sidebar-operator", username: "sidebar-operator", displayName: "Sidebar Operator", role: identity.role },
    hasPermission: (resource: string, action: string) => identity.permissions.includes(resource + ":" + action),
    logout: async () => {},
  }),
}));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/page-data-health", () => ({ PageDataHealth: () => null }));

function renderAt(path: string): string {
  const url = new URL(path, "https://echelon.test");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
      createElement(Router, { ssrPath: url.pathname, ssrSearch: url.search },
        createElement(Layout, { children: createElement("main", null, "Connected procurement") }))));
  } finally { queryClient.clear(); }
}
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map(match => match[1].replace(/&amp;/g, "&"));
}

beforeEach(() => {
  identity.role = "picker";
  identity.permissions = ["inventory:view", "inventory:adjust", "purchasing:view",
    "inventory_planning:view", "orders:edit", "dropship:manage_operations"];
});

describe("procurement sidebar grant boundaries", () => {
  it.each([
    ["/inventory/cutover", "/inventory/cutover"],
    ["/order-edits", "/order-edits"],
    ["/channels/inventory", "/channels/inventory"],
    ["/dropship?tab=finance", "/dropship?tab=finance"],
  ])("retains the existing parent role restriction for %s", (path, href) => {
    // Render each group's active location so a collapsed group cannot hide an
    // accidental permission bypass from this assertion.
    expect(hrefs(renderAt(path))).not.toContain(href);
  });

  it("admits only the explicitly granted procurement children for a picker", () => {
    const procurementLinks = hrefs(renderAt("/receiving"));
    expect(procurementLinks).toEqual(expect.arrayContaining(["/receiving", "/purchase-orders", "/shipments"]));
    expect(procurementLinks).not.toContain("/demand-planner");
    const payableLinks = hrefs(renderAt("/ap-invoices"));
    expect(payableLinks).toContain("/ap-invoices");
    expect(payableLinks).not.toContain("/ap");
    expect(payableLinks).not.toContain("/ap-payments");
  });

  it("does not admit procurement children using unrelated named grants", () => {
    identity.permissions = ["inventory_planning:view", "orders:edit", "dropship:manage_operations"];
    expect(hrefs(renderAt("/receiving"))).not.toContain("/receiving");
    expect(hrefs(renderAt("/ap-invoices"))).not.toContain("/ap-invoices");
  });

  it("retains the legacy lead plus child-grant path for an unrelated route", () => {
    identity.role = "lead";
    expect(hrefs(renderAt("/inventory/cutover"))).toContain("/inventory/cutover");
    identity.permissions = ["purchasing:view"];
    expect(hrefs(renderAt("/inventory/cutover"))).not.toContain("/inventory/cutover");
  });
});
