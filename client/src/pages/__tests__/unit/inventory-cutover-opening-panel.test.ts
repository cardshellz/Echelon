import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchOpeningSource, InventoryCutoverOpeningPanel } from "../../inventory-cutover-opening-panel";
import { openingSaved, openingSource } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

const state = vi.hoisted(() => ({ source: null as unknown, error: null as Error | null, fetching: false,
  pending: false, refetch: vi.fn(), mutate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: state.source, error: state.error, isError: state.error !== null, isFetching: state.fetching, refetch: state.refetch })),
  useMutation: vi.fn(() => ({ error: null, data: null, isPending: state.pending, mutate: state.mutate })),
}));
const render = (overrides: Partial<Parameters<typeof InventoryCutoverOpeningPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(InventoryCutoverOpeningPanel, { actorId: "operator-1", canActivate: true,
    onStateChanged: vi.fn(), ...overrides }));
beforeEach(() => { state.source = null; state.error = null; state.fetching = false; state.pending = false; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe("existing-page opening verification panel", () => {
  it.each([{ actorId: null }, { canActivate: false }])("does not expose actions without activation authority %j", props => {
    state.source = openingSource(); expect(render(props)).toBe("");
  });
  it("requires manual capture and isolates evidence per authenticated operator", () => {
    expect(render()).toContain("Capture current recorded data");
    expect(state.refetch).not.toHaveBeenCalled(); expect(state.mutate).not.toHaveBeenCalled();
    expect(vi.mocked(useQuery).mock.calls[0][0]).toMatchObject({ enabled: false, retry: false, gcTime: 0,
      queryKey: ["/api/inventory-planning/admin/cutover-opening/source", "operator-1"] });
  });
  it("shows meaningful order, SKU, warehouse and bin references without calling records a count", () => {
    state.source = openingSource(); const html = render();
    for (const label of ["Order #CS-1001", "P5", "MAIN — Main warehouse", "PICK-A-01"]) expect(html).toContain(label);
    expect(html).toContain("database records, not proof of a physical count");
    expect(html).toContain("Saving here does not correct stock, change authority or publish quantities");
    expect(html).toContain("Lot and owner quantities start blank");
    expect(html).toContain("SKU/bin totals are calculated from those lot observations");
    expect(html).not.toContain("Switch to canonical authority");
  });
  it("does not allow import or template export from stale source after refresh failure", () => {
    state.source = openingSource(); state.error = new Error("Refresh failed"); const html = render();
    expect(html).toContain("Previous source records below may be stale");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Download blank verification worksheet/);
    expect(html).toMatch(/<input[^>]*disabled/);
  });
  it("keeps saved evidence separate from activation or stock correction", () => {
    state.source = { ...openingSource(), latestVerification: openingSaved() };
    const html = render(); expect(html).toContain("Verification 7 is saved as immutable evidence");
    expect(html).toContain("Stock and inventory authority are unchanged");
  });
  it("does not present an older saved verification as proof of current records", () => {
    state.source = { ...openingSource(), latestVerification: { ...openingSaved(), sourceEvidenceHash: "f".repeat(64) } };
    expect(render()).toContain("not verification of the current records");
  });
  it("escapes reference labels and explicitly names missing labels", () => {
    const source = openingSource(); source.labels = [{ kind: "order", id: "1", label: '<script>alert("secret")</script>' }];
    state.source = source; const html = render();
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).toContain("label unavailable");
  });
  it("bounds mounted rows while preserving access to the entire source", () => {
    const source = openingSource(); source.evidence.levels = Array.from({ length: 50_000 }, (_, index) => ({ ...source.evidence.levels[0], id: index + 1 }));
    state.source = source; const html = render();
    expect(html).toContain("Page 1 of 2500"); expect(html).toContain("50000 total"); expect((html.match(/<tr>/g) ?? []).length).toBe(23);
  });
  it("rejects handler bypass without authorization", async () => {
    render({ canActivate: false });
    for (const [options] of vi.mocked(useMutation).mock.calls) await expect(options.mutationFn!({} as never, {} as never)).rejects.toThrow();
    const query = vi.mocked(useQuery).mock.calls[0][0];
    await expect(async () => (query.queryFn as (input: unknown) => Promise<unknown>)({ signal: new AbortController().signal })).rejects.toThrow("authorized operator");
  });
});

describe("opening source HTTP boundary", () => {
  it("validates the complete source and does not cache authenticated evidence", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(openingSource()))); vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await expect(fetchOpeningSource(signal)).resolves.toEqual(openingSource());
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/inventory-planning/admin/cutover-opening/source", {
      method: "GET", credentials: "include", cache: "no-store", signal });
  });
  it.each(["invalid JSON", '{"ready":true}', JSON.stringify({ ...openingSource(), secret: "unexpected" })])("rejects malformed or partial response %#", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(fetchOpeningSource()).rejects.toThrow(/valid JSON|validation/);
  });
  it("reports failed capture without showing it as source evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private SQL", { status: 500 })));
    await expect(fetchOpeningSource()).rejects.toThrow("HTTP 500");
  });
});
