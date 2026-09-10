import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchOpeningSource, InventoryCutoverOpeningPanel, OpeningPromiseHandoffEvidence } from "../../inventory-cutover-opening-panel";
import { openingAssessment, openingSaved, openingSource } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

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
    expect(html).toContain("Those raw counters stay in the recorded reference");
    expect(html).toContain("An order owner&#x27;s reserved and picked quantities describe physical holds only");
    expect(html).toContain("unknown or mixed cases remain blocked");
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

function promiseAssessment() {
  const assessment = openingAssessment();
  assessment.plan.orders = [{ orderId: 1, warehouseId: 1, lines: [{ orderItemId: 11, targetVariantId: 101, productId: 20,
    requestedQty: "6", reservedQty: "0", pickedQty: "0", freshDemandQty: "6", allocations: [] }] }];
  assessment.plan.legacyPromiseReleases = [{ inventoryLevelId: 10, warehouseLocationId: 100, warehouseId: 1,
    productVariantId: 101, variantQty: "0", reservedQty: "6", pickedQty: "0", packedQty: "0",
    owners: [{ orderId: 1, orderItemId: 11, reservedQty: "6", journalCount: "1", journalHash: "e".repeat(64) }] }];
  return assessment;
}

describe("opening assessment empty-bin promise disclosure", () => {
  it("shows exact server-proven owners and quantities without authorizing operational changes", () => {
    const source = openingSource(); const assessment = promiseAssessment(); const before = structuredClone(assessment);
    source.evidence.levels[0] = { ...source.evidence.levels[0], variantQty: "0", reservedQty: "6", pickedQty: "0" };
    const html = renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source, assessment }));
    for (const label of ["Order #CS-1001", "P5", "MAIN — Main warehouse", "PICK-A-01", "line 11", "level 10"]) expect(html).toContain(label);
    expect(html).toContain("1 complete empty-bin position(s), for 1 order line(s)");
    expect(html).toContain("<td>6</td><td>6</td>");
    expect(html).toContain("No physical stock is released"); expect(html).toContain("including any shortage");
    expect(html).toContain("Preview and verification save change no counters");
    expect(html).toContain("separately reviewed final activation");
    expect(html).not.toContain("<button"); expect(html).not.toContain("<input"); expect(assessment).toEqual(before);
  });
  it("does not infer a release from an empty recorded bin or uploaded owner quantities", () => {
    const source = openingSource(); source.evidence.levels[0] = { ...source.evidence.levels[0], variantQty: "0", reservedQty: "6", pickedQty: "0" };
    expect(renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source, assessment: openingAssessment() }))).toBe("");
  });
  it("does not present proposals as approval when other opening findings remain", () => {
    const assessment = promiseAssessment(); assessment.ready = false; assessment.plan.ready = false;
    assessment.blockers = [{ code: "CURRENT_BLOCKED", subject: "level:20", message: "Current evidence remains incomplete" }];
    const html = renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source: openingSource(), assessment }));
    expect(html).toContain("Other findings still block this opening");
    expect(html).toContain("does not authorize saving or activation"); expect(html).not.toContain("<button");
  });
  it("renders unknown references explicitly and escapes external labels", () => {
    const source = openingSource(); source.labels = [{ kind: "order", id: "1", label: '<script>alert("order")</script>' }];
    const assessment = promiseAssessment(); assessment.plan.orders = [];
    const html = renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source, assessment }));
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain("label unavailable"); expect(html).toContain("Not proven in the returned plan");
  });
  it("keeps pack and case quantities per variant without summing them across SKUs", () => {
    const source = openingSource(); const assessment = promiseAssessment();
    source.labels = source.labels.filter(row => row.kind !== "variant");
    source.labels.push({ kind: "variant", id: "101", label: "P5 — 5-pack" }, { kind: "variant", id: "102", label: "P100 — 100-unit case" });
    assessment.plan.legacyPromiseReleases.push({ ...assessment.plan.legacyPromiseReleases[0], inventoryLevelId: 20,
      productVariantId: 102, reservedQty: "2", owners: [{ orderId: 1, orderItemId: 12, reservedQty: "2", journalCount: "1", journalHash: "f".repeat(64) }] });
    assessment.plan.orders[0].lines.push({ ...assessment.plan.orders[0].lines[0], orderItemId: 12,
      targetVariantId: 102, requestedQty: "2", freshDemandQty: "2" });
    const html = renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source, assessment }));
    expect(html).toContain("2 complete empty-bin position(s), for 2 order line(s)");
    expect(html).toContain("P5 — 5-pack"); expect(html).toContain("P100 — 100-unit case");
    expect(html).toContain("<td>6</td><td>6</td>"); expect(html).toContain("<td>2</td><td>2</td>");
    expect(html).not.toContain("8 recorded promise units"); expect(html).not.toContain("promise units across");
  });
  it("pages every proven owner without mounting the complete cohort or combining quantities", () => {
    const assessment = promiseAssessment();
    assessment.plan.legacyPromiseReleases = Array.from({ length: 25 }, (_, index) => ({ ...assessment.plan.legacyPromiseReleases[0],
      inventoryLevelId: index + 1, reservedQty: "2147483647", owners: [{ orderId: index + 1, orderItemId: index + 1,
        reservedQty: "2147483647", journalCount: "1", journalHash: "e".repeat(64) }] }));
    assessment.plan.orders = assessment.plan.legacyPromiseReleases.map(release => ({ orderId: release.owners[0].orderId, warehouseId: 1,
      lines: [{ ...assessment.plan.orders[0].lines[0], orderItemId: release.owners[0].orderItemId, requestedQty: "2147483647", freshDemandQty: "2147483647" }] }));
    const html = renderToStaticMarkup(createElement(OpeningPromiseHandoffEvidence, { source: openingSource(), assessment }));
    expect(html).toContain("25 complete empty-bin position(s), for 25 order line(s)");
    expect(html).not.toContain("53687091175"); expect(html).toContain("Page 1 of 2"); expect(html).toContain("25 total");
    expect((html.match(/<tr>/g) ?? []).length).toBe(21);
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
