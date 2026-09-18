import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryObserver, useMutation, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promiseSafetyAdminViewSchema } from "@shared/types/inventory-promise-safety-admin";
import { PromiseSafetyPolicyPanel } from "../../promise-safety-policy-panel";

const state = vi.hoisted(() => ({ data: undefined as unknown, error: null as Error | null, loading: false }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: vi.fn(() => ({ data: state.data, error: state.error, isLoading: state.loading })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function view() {
  return promiseSafetyAdminViewSchema.parse({
    product: { id: 17, sku: "SKU-17", name: "Protected product" },
    variants: [], warehouses: [], policyHeads: [], demandEvidence: [],
    demandMethod: {
      methodVersion: "irreversible_consumption_v1_28d", observationDays: 28,
      minimumObservedDays: 14, minimumSourceEvents: 2, minimumActiveDays: 2,
      minimumConsumptionUnits: 3, recencyDays: 14, maximumEvidenceAgeHours: 36,
    },
  });
}

function render(canView = true, canEdit = false) {
  return renderToStaticMarkup(createElement(PromiseSafetyPolicyPanel, { productId: 17, canView, canEdit }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.data = view(); state.error = null; state.loading = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("promise safety view boundary", () => {
  it("does not fetch or expose retained data without planning view permission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = render(false, true);
    expect(html).toContain("Inventory planning view permission is required");
    expect(html).not.toContain("Protected product");
    expect(html).not.toContain("safety-change-reason");
    const options = vi.mocked(useQuery).mock.calls[0]![0];
    expect(options).toMatchObject({ enabled: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await observer.refetch();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain("view permission is required");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      unsubscribe(); client.clear();
    }
  });

  it.each([[false, true], [true, false]])("guards both mutation handlers for view=%s edit=%s", async (canView, canEdit) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(canView, canEdit);
    for (const [options] of vi.mocked(useMutation).mock.calls) {
      await expect(options.mutationFn!(undefined as never)).rejects.toThrow("edit permission is required");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders safety separately from reorder buffering with required safety reasons unchanged", () => {
    const html = render(true, false);
    expect(html).toContain("ATP promise safety floor");
    expect(html).toContain("SKU-17 — Protected product");
    expect(html).toContain("safetyStockDays");
    expect(html).toContain("Change reason");
    expect(html).toContain("Refresh reason");
    expect(html).toContain("view access only");
    expect(html).toMatch(/<textarea[^>]*id="safety-change-reason"[^>]*disabled/);
  });

  it("forwards cancellation and validates the existing read endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(view())));
    vi.stubGlobal("fetch", fetchMock); render();
    const options = vi.mocked(useQuery).mock.calls[0]![0];
    expect(options.enabled).toBe(true);
    const signal = new AbortController().signal;
    if (typeof options.queryFn !== "function") throw new Error("Missing query function");
    expect(await options.queryFn({ signal } as never)).toEqual(view());
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory-planning/admin/promise-safety/17", { credentials: "include", signal });
  });

  it("shows read failures without substituting an empty safety policy", () => {
    state.data = undefined; state.error = new Error("Safety evidence unavailable");
    const html = render();
    expect(html).toContain("Safety evidence unavailable");
    expect(html).not.toContain("Create safety draft");
  });
});
