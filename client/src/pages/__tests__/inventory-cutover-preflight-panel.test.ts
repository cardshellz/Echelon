import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { inventoryCutoverPreflightSchema, type InventoryCutoverPreflight } from "@shared/types/inventory-cutover-preflight";
import { evidencePage, fetchInventoryCutoverPreflight, InventoryCutoverEvidence, InventoryCutoverPreflightPanel } from "../inventory-cutover-preflight-panel";

const queryState = vi.hoisted(() => ({
  data: null as unknown, error: null as Error | null, isFetching: false, refetch: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(() => queryState) }));

beforeEach(() => {
  queryState.data = null;
  queryState.error = null;
  queryState.isFetching = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("inventory cutover evidence panel", () => {
  it("requires view permission even when cached evidence exists", () => {
    queryState.data = reportFixture();
    expect(renderPanel(false)).toBe("");
  });

  it("starts without a snapshot and only offers manual read-only capture", () => {
    const html = renderPanel();
    expect(html).toContain("Capture read-only evidence");
    expect(html).toContain("No snapshot captured");
    expect(html).toContain("not full activation readiness");
    expect(html).not.toContain("<input");
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({
      enabled: false, retry: false, refetchInterval: false, refetchOnMount: false,
      refetchOnWindowFocus: false, refetchOnReconnect: false,
    });
    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  it("shows capture progress and disables the refresh button", () => {
    queryState.isFetching = true;
    const html = renderPanel();
    expect(html).toContain("Capturing evidence");
    expect(html).toContain("No inventory is being changed");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("shows an initial error without inventing snapshot or readiness", () => {
    queryState.error = new Error("Evidence service unavailable");
    const html = renderPanel();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Evidence service unavailable");
    expect(html).toContain("No verified snapshot is available");
    expect(html).not.toContain("Runtime authority:");
  });

  it("preserves prior evidence visibly marked stale when refresh fails", () => {
    queryState.data = reportFixture();
    queryState.error = new Error("Refresh failed");
    const html = renderPanel();
    expect(html).toContain("may be stale");
    expect(html).toContain("not current readiness evidence");
    expect(html).toContain("2026-09-07T14:00:00.000Z");
    expect(html).toContain("not approval to activate");
  });

  it("labels the previous snapshot while a manual refresh is in flight", () => {
    queryState.data = reportFixture();
    queryState.isFetching = true;
    expect(renderPanel()).toContain("previous snapshot remains below until a new capture succeeds");
  });

  it("shows evidence counts, unknown authority and explicit unassessed custody", () => {
    const report = reportFixture();
    report.runtimeAuthority = null;
    const html = renderToStaticMarkup(createElement(InventoryCutoverEvidence, { report }));
    expect(html).toContain("Runtime authority: Unknown");
    expect(html).toContain("Unattributed reservation levels");
    expect(html).toContain("not free stock");
    expect(html).toContain("Not evaluated by this report");
    expect(html).toContain("External 3PL custody and freshness are not evaluated");
    expect(html).not.toContain("<button");
  });

  it("shows finding instructions and exact record identities, not guessed repairs", () => {
    const report = reportFixture();
    report.findings = [{ code: "REVIEW_PROGRESS", message: "Review recorded physical progress before assigning demand.",
      orderId: 80, orderItemId: 81, inventoryLevelId: 82 }];
    report.outcome = "review_required";
    const html = renderToStaticMarkup(createElement(InventoryCutoverEvidence, { report }));
    expect(html).toContain("Review recorded physical progress before assigning demand.");
    expect(html).toContain("Order 80 · line 81 · inventory level 82");
    expect(html).toContain("Findings need review");
  });

  it("bounds a large cohort to one page of records in the DOM", () => {
    const report = reportFixture();
    report.lines = Array.from({ length: 50_000 }, (_, index) => ({
      orderId: 80, orderItemId: index + 1, warehouseId: 1, sku: `SKU-${index + 1}`, orderStatus: "pending",
      itemStatus: "pending", productVariantId: 100, orderedQty: "2", recordedPickedQty: "0", recordedFulfilledQty: "0",
      candidateDemandQty: "2", disposition: "unstarted_demand" as const, findingCodes: [],
    }));
    const html = renderToStaticMarkup(createElement(InventoryCutoverEvidence, { report }));
    expect(html).toContain("50000 records · page 1 of 2500");
    expect(html).toContain("SKU-20");
    expect(html).not.toContain("SKU-21");
    expect(html).toContain('aria-label="Next Order lines page"');
  });

  it("paginates deterministically and clamps stale or invalid indexes", () => {
    const rows = Array.from({ length: 45 }, (_, index) => index);
    expect(evidencePage(rows, 1)).toEqual({ page: 1, totalPages: 3, rows: rows.slice(20, 40) });
    expect(evidencePage(rows, 999)).toEqual({ page: 2, totalPages: 3, rows: rows.slice(40) });
    expect(evidencePage(rows, -1).page).toBe(0);
    expect(evidencePage(rows, NaN).page).toBe(0);
    expect(evidencePage([], 9)).toEqual({ page: 0, totalPages: 1, rows: [] });
  });
});

describe("cutover evidence HTTP boundary", () => {
  it("only performs an authenticated GET and validates the complete response", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reportFixture()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchInventoryCutoverPreflight(signal)).toEqual(reportFixture());
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/inventory-planning/admin/cutover-preflight", {
      method: "GET", credentials: "include", signal,
    });
  });

  it.each([403, 503])("classifies HTTP %s without rendering unchecked server bodies", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unchecked error body", { status })));
    await expect(fetchInventoryCutoverPreflight()).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects unvalidated or readiness-claiming payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...reportFixture(), activationReadinessEvaluated: true,
    }), { status: 200 })));
    await expect(fetchInventoryCutoverPreflight()).rejects.toThrow("could not be verified");
  });

  it("reports invalid JSON explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200 })));
    await expect(fetchInventoryCutoverPreflight()).rejects.toThrow("not valid JSON");
  });

  it("does not swallow network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(fetchInventoryCutoverPreflight()).rejects.toThrow("Network unavailable");
  });
});

function renderPanel(canView = true, actorId: string | null = "operator-a"): string {
  return renderToStaticMarkup(createElement(InventoryCutoverPreflightPanel, { canView, actorId }));
}

function reportFixture(): InventoryCutoverPreflight {
  return inventoryCutoverPreflightSchema.parse({
    contractVersion: "inventory_cutover_preflight_v1", scope: "nonterminal_wms_demand_and_current_inventory_encumbrances",
    capturedAt: "2026-09-07T14:00:00.000Z", evidenceHash: "a".repeat(64), runtimeAuthority: "legacy", authorityRevision: "1",
    outcome: "evidence_captured", operationalWriteAttempted: false, activationReadinessEvaluated: false,
    excludedTerminalOrderCount: "5", summary: { orders: 0, lines: 0, unstartedDemandLines: 0, noInventoryDemandLines: 0,
      reviewLines: 0, inventoryLevels: 0, unattributedReservationLevels: 0 }, lines: [], inventoryLevels: [], findings: [],
    notEvaluated: ["External 3PL custody and freshness are not evaluated", "Whole-catalog activation readiness is not evaluated"],
  });
}
