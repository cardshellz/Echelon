import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProcurementPromiseSafetySettings from "../../ProcurementPromiseSafetySettings";
import ProcurementSettings from "../../ProcurementSettings";
import { PromiseSafetyPolicyPanel } from "../../promise-safety-policy-panel";

const state = vi.hoisted(() => ({
  canView: true, canEdit: false, error: null as Error | null,
  data: [{ id: 17, sku: "SKU-17", name: "Example product" }] as unknown,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({
  hasPermission: (resource: string, action: string) => resource === "inventory_planning"
    && (action === "view" ? state.canView : action === "edit" && state.canEdit),
}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: state.data, isLoading: false, isFetching: false,
    isError: state.error !== null, error: state.error, refetch: vi.fn() })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false })),
  useQueryClient: vi.fn(() => ({})),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../promise-safety-policy-panel", () => ({
  PromiseSafetyPolicyPanel: vi.fn(({ productId }: { productId: number }) => createElement("div", {}, `Safety product ${productId}`)),
}));

function render(search = "", page = ProcurementPromiseSafetySettings) {
  return renderToStaticMarkup(createElement(Router, {
    ssrPath: "/settings/procurement/promise-safety", ssrSearch: search, children: createElement(page),
  }));
}

beforeEach(() => {
  vi.clearAllMocks(); state.canView = true; state.canEdit = false; state.error = null;
  state.data = [{ id: 17, sku: "SKU-17", name: "Example product" }];
});
afterEach(() => vi.unstubAllGlobals());

describe("procurement ATP promise-safety settings", () => {
  it("disables product reads and hides cached products without planning view permission", async () => {
    state.canView = false; state.canEdit = true;
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const html = render("productId=17");
    expect(html).toContain("view permission is required");
    expect(html).not.toContain("Example product");
    expect(PromiseSafetyPolicyPanel).not.toHaveBeenCalled();
    const query = vi.mocked(useQuery).mock.calls[0]![0];
    expect(query.enabled).toBe(false);
    if (typeof query.queryFn !== "function") throw new Error("Missing query function");
    await expect(query.queryFn({ signal: new AbortController().signal } as never)).rejects.toThrow("view permission is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves product deep links and forwards edit permission %s", (canEdit) => {
    state.canEdit = canEdit;
    const html = render("productId=17");
    expect(html).toContain("ATP promise safety");
    expect(html).toContain("safetyStockDays");
    expect(html).toContain("does not activate it or change live ATP");
    expect(PromiseSafetyPolicyPanel).toHaveBeenCalledWith(expect.objectContaining({ productId: 17, canView: true, canEdit }), undefined);
  });

  it.each(["", "productId=0", "productId=1.5", "productId=2147483648", "productId=17&productId=18"])("does not select a product from missing or invalid input %s", (search) => {
    const html = render(search);
    expect(PromiseSafetyPolicyPanel).not.toHaveBeenCalled();
    expect(html).toContain("Select a product to review");
    if (search) expect(html).toContain("product link is invalid");
  });

  it("keeps a deep-linked selection visible when it is outside the current search results", () => {
    const html = render("productId=23");
    expect(html).toContain("Selected product #23");
    expect(html).toContain("Safety product 23");
  });

  it("uses the bounded existing product endpoint and forwards cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ products: state.data })));
    vi.stubGlobal("fetch", fetchMock); render();
    const query = vi.mocked(useQuery).mock.calls[0]![0];
    if (typeof query.queryFn !== "function") throw new Error("Missing query function");
    const signal = new AbortController().signal;
    expect(await query.queryFn({ signal } as never)).toEqual(state.data);
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory-planning/admin/products?limit=50", { credentials: "include", signal });
  });

  it("reports product read errors without claiming an empty catalog", () => {
    state.error = new Error("Product search unavailable"); state.data = undefined;
    const html = render();
    expect(html).toContain("Product search unavailable");
    expect(html).not.toContain("No products match");
  });

  it.each([false, true])("gates the Procurement Settings link on planning view permission %s", (canView) => {
    state.canView = canView; state.data = undefined;
    const html = render("", ProcurementSettings);
    expect(html.includes('href="/settings/procurement/promise-safety"')).toBe(canView);
  });
});
