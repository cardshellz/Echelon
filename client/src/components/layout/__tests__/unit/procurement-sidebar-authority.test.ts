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
  ])("preserves the existing named-grant access to %s", (path, href) => {
    // Existing child grants override the parent's legacy role filter. Render
    // the active group so collapsed markup cannot hide an access regression.
    expect(hrefs(renderAt(path))).toContain(href);
    identity.permissions = ["purchasing:view"];
    expect(hrefs(renderAt(path))).not.toContain(href);
  });

  it("admits only the explicitly granted procurement children for a picker", () => {
    const procurementLinks = hrefs(renderAt("/receiving"));
    expect(procurementLinks).toEqual(expect.arrayContaining(["/receiving", "/purchase-orders", "/shipments"]));
    expect(procurementLinks).not.toContain("/demand-planner");
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

  it("preserves parent role inheritance for children without explicit access", () => {
    expect(hrefs(renderAt("/demand-planner"))).not.toContain("/demand-planner");
    identity.role = "lead";
    expect(hrefs(renderAt("/demand-planner"))).toContain("/demand-planner");
    expect(hrefs(renderAt("/inventory/history"))).not.toContain("/inventory/history");
    identity.role = "admin";
    expect(hrefs(renderAt("/inventory/history"))).toContain("/inventory/history");
  });
});
