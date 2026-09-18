import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import SupplyTransformations from "../SupplyTransformations";
import InventoryCutover from "../InventoryCutover";
import { inventoryPlanningProductHref, parseInventoryPlanningProductId } from "../inventory-planning-navigation";

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  search: "",
  queryData: new Map<string, unknown>(),
  mutate: vi.fn(), navigate: vi.fn(), refetch: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "operator-1" },
    hasPermission: (resource: string, action: string) => state.permissions.has(`${resource}:${action}`) }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: ReactNode }) =>
    createElement("a", { href, ...props }, children),
  useSearch: () => state.search,
  useLocation: () => ["/inventory/cutover", state.navigate],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { queryKey: unknown[] }) => ({
    data: state.queryData.get(String(options.queryKey[0])), isLoading: false,
    error: null, isError: false, isFetching: false, refetch: state.refetch,
  })),
  useMutation: () => ({ data: undefined, mutate: state.mutate, reset: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../inventory-catalog-batch-panel", () => ({
  InventoryCatalogBatchPanel: () => createElement("section", null, "Catalog batch"),
}));
vi.mock("../inventory-cutover-preflight-panel", () => ({
  InventoryCutoverPreflightPanel: () => createElement("section", null, "Preflight evidence"),
}));
vi.mock("../inventory-cutover-opening-panel", () => ({
  InventoryCutoverOpeningPanel: () => createElement("section", null, "Opening evidence"),
}));
vi.mock("../inventory-publication-recovery-panel", () => ({
  InventoryPublicationRecoveryPanel: () => createElement("section", null, "Publication recovery"),
}));
vi.mock("../inventory-cutover-controls", () => ({
  InventoryCutoverControls: () => createElement("section", null, "Explicit cutover controls"),
}));

beforeEach(() => {
  state.permissions = new Set(["inventory_planning:view"]);
  state.search = "";
  state.queryData.clear();
  vi.clearAllMocks();
});

describe("inventory planning product deep links", () => {
  it.each(["", "?productId=", "?productId=0", "?productId=-1", "?productId=1.5",
    "?productId=1e3", "?productId=01", "?productId=2147483648",
    "?productId=9007199254740992", "?productId=1&productId=2", "?productId=%20",
  ])("does not query an invalid product selection: %s", (search) => {
    expect(parseInventoryPlanningProductId(search)).toBeNull();
  });

  it("round-trips a product selection without losing the database ID", () => {
    expect(parseInventoryPlanningProductId("?productId=2147483647")).toBe(2147483647);
    expect(parseInventoryPlanningProductId("productId=12&tab=variants")).toBe(12);
    expect(inventoryPlanningProductHref("/inventory/cutover", 12)).toBe("/inventory/cutover?productId=12");
    expect(inventoryPlanningProductHref("/inventory/cutover", null)).toBe("/inventory/cutover");
    expect(() => inventoryPlanningProductHref("/inventory/cutover", 0)).toThrow("product ID");
  });
});

describe("conversion surface relocation", () => {
  it.each([SupplyTransformations, InventoryCutover])("disables every read and hides controls without view permission", (Page) => {
    state.permissions.clear();
    state.search = "?productId=12";
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("Inventory planning view permission is required");
    expect(html).not.toContain("<button");
    for (const [options] of vi.mocked(useQuery).mock.calls) {
      expect(options).toMatchObject({ enabled: false });
    }
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("keeps only per-product reads and contextual destination links in the retained editor", () => {
    state.search = "?productId=12";
    const html = renderToStaticMarkup(createElement(SupplyTransformations));
    const options = vi.mocked(useQuery).mock.calls.map(([option]) => option);
    expect(options.map((option) => option.queryKey?.[0])).toEqual([
      "/api/inventory-planning/admin/products",
      "/api/inventory-planning/admin/supply-transformations",
      "/api/inventory-planning/admin/supply-transformations/shadow-runs/latest",
      "/api/inventory-planning/admin/migration-queue/channel-preview",
    ]);
    expect(options[1]).toMatchObject({ queryKey: ["/api/inventory-planning/admin/supply-transformations", 12], enabled: true });
    expect(html).toContain('href="/inventory/cutover?productId=12"');
    expect(html).toContain('href="/settings/procurement/promise-safety?productId=12"');
    expect(html).not.toContain("Full-catalog publication preparation");
    expect(html).not.toContain("Phase 3 migration queue");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("renders the six global sections at cutover without running any command", () => {
    state.search = "?productId=12";
    const html = renderToStaticMarkup(createElement(InventoryCutover));
    for (const label of ["Catalog batch", "Phase 3 migration queue", "Preflight evidence",
      "Opening evidence", "Full-catalog publication preparation dry run", "Publication recovery"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/inventory/supply-transformations?productId=12"');
    const options = vi.mocked(useQuery).mock.calls.map(([option]) => option);
    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({ queryKey: ["/api/inventory-planning/admin/migration-queue"], enabled: true });
    expect(options[1]).toMatchObject({ queryKey: ["/api/inventory-planning/admin/supply-transformations", 12], enabled: true });
    expect(options[2]).toMatchObject({ queryKey: ["/api/inventory-planning/admin/activation-runs/open", "operator-1"], enabled: false });
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Refresh provider quantities/);
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("preserves actor-scoped open preparation polling only with activate permission", () => {
    state.permissions.add("inventory_planning:activate");
    renderToStaticMarkup(createElement(InventoryCutover));
    expect(vi.mocked(useQuery).mock.calls[2]![0]).toMatchObject({
      queryKey: ["/api/inventory-planning/admin/activation-runs/open", "operator-1"], enabled: true,
    });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("registers planning-permission routes without changing admin procurement settings access", () => {
    const app = readFileSync(resolve(process.cwd(), "client/src/App.tsx"), "utf8");
    const nav = readFileSync(resolve(process.cwd(), "client/src/components/layout/AppShell.tsx"), "utf8");
    for (const path of ["/inventory/cutover", "/settings/procurement/promise-safety"]) {
      const route = app.slice(app.indexOf(`<Route path="${path}">`));
      expect(route.slice(0, route.indexOf("</Route>"))).toContain('requiredPermission={{ resource: "inventory_planning", action: "view" }}');
    }
    expect(app).toContain('<ProtectedRoute component={ProcurementSettings} allowedRoles={["admin"]} />');
    expect(nav).toContain('href: "/inventory/cutover"');
  });
});
