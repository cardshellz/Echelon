import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = { queryKey: readonly unknown[]; enabled?: boolean };
type MutationOptions = { mutationFn: (...args: unknown[]) => Promise<unknown> };

const fixture = vi.hoisted(() => ({
  legacyRole: "admin",
  systemRoles: [] as string[],
  grants: [] as string[],
  path: "/picking",
  queries: [] as QueryOptions[],
  mutations: [] as MutationOptions[],
  data: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({
  user: { id: "staff-1", username: "staff-1", role: fixture.legacyRole },
  permissions: fixture.grants,
  hasPermission: (resource: string, action: string) => fixture.grants.includes(`${resource}:${action}`),
  hasSystemRole: (role: string) => fixture.systemRoles.includes(role),
}) }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: (options: QueryOptions) => {
    fixture.queries.push(options);
    return { data: fixture.data[options.queryKey.join("|")], isLoading: false, isFetching: false,
      isError: false, error: null, dataUpdatedAt: 1, refetch: vi.fn() };
  },
  useMutation: (options: MutationOptions) => {
    fixture.mutations.push(options);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn(), getQueryData: vi.fn() }),
}));
vi.mock("wouter", async importOriginal => ({
  ...await importOriginal<typeof import("wouter")>(),
  useLocation: () => [fixture.path, vi.fn()],
  useSearch: () => "",
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({
  pickingMode: "single", pickerViewMode: "focus", soundTheme: "silent", hapticEnabled: false,
  autoRelease: false, releaseDelay: "immediate", setPickingMode: vi.fn(), setPickerViewMode: vi.fn(),
  setSoundTheme: vi.fn(), setHapticEnabled: vi.fn(), setAutoRelease: vi.fn(), setReleaseDelay: vi.fn(),
}) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/features/purchasing/PurchasePipeline", () => ({ PurchasePipeline: () => null }));
vi.mock("@/components/WalmartConnectionPanel", () => ({ default: () => createElement("div", {}, "Connection setup") }));
vi.mock("@/features/channel-listing-publication/ChannelListingPublicationWorkspace", () => ({ ChannelListingPublicationWorkspace: () => null }));

import Picking from "../../Picking";
import PickingPage from "../../PickingPage";
import Orders from "../../Orders";
import PurchasingDashboard from "../../PurchasingDashboard";
import { WalmartChannelRouteHost } from "../../WalmartChannelPage";

function render(page: React.ComponentType) {
  fixture.queries = [];
  fixture.mutations = [];
  return renderToStaticMarkup(createElement(page));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.legacyRole = "admin";
  fixture.systemRoles = [];
  fixture.grants = [];
  fixture.path = "/picking";
  fixture.data = {};
  fixture.queries = [];
  fixture.mutations = [];
  vi.stubGlobal("React", React); // Existing Vitest transform uses classic JSX.
  vi.stubGlobal("window", { location: { search: "", protocol: "http:", host: "synthetic.invalid" } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access in offline test")));
});
afterEach(() => vi.unstubAllGlobals());

describe("page authority comes from verified assignments and grants", () => {
  it("does not expose supervisor picking tabs from a legacy admin label", () => {
    const html = render(PickingPage);
    expect(html).not.toContain('>Logs<');
    expect(html).not.toContain('>Metrics<');
    expect(html).not.toContain('>Settings<');
  });

  it("keeps supervisor picking tabs for an explicitly assigned lead with a legacy picker label", () => {
    fixture.legacyRole = "picker";
    fixture.systemRoles = ["lead"];
    const html = render(PickingPage);
    expect(html).toContain('>Logs<');
    expect(html).toContain('>Metrics<');
    expect(html).toContain('>Settings<');
  });

  it.each([false, true])("controls picking exception reads from explicit assignment %s", assigned => {
    fixture.legacyRole = assigned ? "picker" : "admin";
    fixture.systemRoles = assigned ? ["lead"] : [];
    const html = render(Picking);
    expect(fixture.queries.find(query => query.queryKey[0] === "exception-orders")?.enabled).toBe(assigned);
    expect(html.includes('data-testid="button-exceptions"')).toBe(assigned);
  });

  it("does not mount a Walmart workspace merely because the legacy label is admin", () => {
    fixture.path = "/channels/walmart/7";
    const html = renderToStaticMarkup(createElement<{ navigationDocumentId?: string }>(WalmartChannelRouteHost, { navigationDocumentId: "synthetic-document" }));
    expect(html).toBe("");
    expect(fixture.queries).toHaveLength(0);
  });

  it("opens Walmart for a custom grant and stops rendering its queries after that grant is absent", () => {
    fixture.path = "/channels/walmart/7";
    fixture.legacyRole = "picker";
    fixture.grants = ["channels:view"];
    const html = renderToStaticMarkup(createElement<{ navigationDocumentId?: string }>(WalmartChannelRouteHost, { navigationDocumentId: "synthetic-document" }));
    expect(html).toContain("Walmart");
    expect(fixture.queries.find(query => query.queryKey[0] === "/api/channels/7/walmart")?.enabled).toBe(true);
    fixture.grants = [];
    fixture.queries = [];
    expect(renderToStaticMarkup(createElement<{ navigationDocumentId?: string }>(WalmartChannelRouteHost, { navigationDocumentId: "synthetic-document" }))).toBe("");
    expect(fixture.queries).toHaveLength(0);
  });

  it.each([
    { legacy: "admin", system: [] as string[], grants: ["inventory:adjust"], allowed: false },
    { legacy: "admin", system: ["admin"], grants: [] as string[], allowed: false },
    { legacy: "admin", system: ["lead"], grants: ["inventory:adjust"], allowed: false },
    { legacy: "picker", system: ["admin"], grants: ["inventory:adjust"], allowed: true },
  ])("preserves assigned Administrator plus adjustment authority for auto-draft: %j", async scenario => {
    fixture.legacyRole = scenario.legacy;
    fixture.systemRoles = scenario.system;
    fixture.grants = scenario.grants;
    render(PurchasingDashboard);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: 7, interruptedRunIds: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    const mutation = fixture.mutations[0];
    expect(mutation).toBeDefined();
    if (scenario.allowed) {
      await expect(mutation.mutationFn()).resolves.toEqual({ runId: 7, interruptedRunIds: [] });
      expect(request).toHaveBeenCalledExactlyOnceWith("/api/purchasing/auto-draft/run", { method: "POST" });
    } else {
      await expect(mutation.mutationFn()).rejects.toThrow("Admin role and inventory adjustment permission");
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each([
    { legacy: "admin", system: [] as string[], grants: [] as string[], allowed: false },
    { legacy: "admin", system: [] as string[], grants: ["orders:priority"], allowed: false },
    { legacy: "picker", system: ["admin"], grants: [] as string[], allowed: true },
    { legacy: "picker", system: ["lead"], grants: [] as string[], allowed: true },
  ])("matches the assigned Administrator/Team Lead priority boundary on both pages: %j", scenario => {
    fixture.legacyRole = scenario.legacy;
    fixture.systemRoles = scenario.system;
    fixture.grants = scenario.grants;
    vi.stubGlobal("window", { location: { search: "?orderId=7" } });
    fixture.data["/api/wms/orders|7|detail"] = {
      id: 7, orderNumber: "SYNTHETIC-7", warehouseStatus: "pending", status: "pending", priority: 1,
      createdAt: "2026-11-04T00:00:00Z", items: [], channel: null, itemCount: 0, customerName: "Synthetic customer",
    };
    const html = render(Orders);
    expect(html.includes("Priority Control")).toBe(scenario.allowed);
    expect(fixture.queries.some(query => query.queryKey[0] === "/api/auth/me")).toBe(false);
    fixture.data["picking-queue"] = [{
      id: 7, orderNumber: "SYNTHETIC-7", warehouseStatus: "pending", priority: 1,
      createdAt: "2026-11-04T00:00:00Z", onHold: 0, assignedPickerId: null, customerName: "Synthetic customer",
      items: [{ id: 9, sku: "SYNTHETIC-SKU", name: "Synthetic item", location: "TEST-01", quantity: 1,
        pickedQuantity: 0, fulfilledQuantity: 0, status: "pending" }],
    }];
    expect(render(Picking).includes('data-testid="button-bump-7"')).toBe(scenario.allowed);
  });
});
