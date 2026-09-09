import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";
import type { InventoryCutoverVerification } from "@shared/types/inventory-cutover-completion";
import { InventoryCutoverControls, postCutoverCommand } from "../../inventory-cutover-controls";

const state = vi.hoisted(() => ({ review: null as unknown, verification: null as unknown,
  error: null as Error | null, fetching: false, pending: false, refetch: vi.fn(), mutate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { queryKey: string[] }) => ({
    data: options.queryKey[0] === "cutover-final-review" ? state.review : state.verification,
    error: state.error, isError: state.error !== null, isFetching: state.fetching, refetch: state.refetch,
  })),
  useMutation: vi.fn(() => ({ error: null, isPending: state.pending, data: null, mutate: state.mutate })),
}));
const HASH = "a".repeat(64);
const TIME = "2026-09-08T12:00:00.000Z";
function review(): InventoryCutoverReview {
  return { contractVersion: "inventory_cutover_review_v1", activationRunId: "1", authorityRevision: "1", capturedAt: TIME,
    reviewHash: HASH, selectionManifestHash: HASH, reconstructionHash: HASH, freshClaimImpactHash: HASH, ready: true,
    manifest: { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [], selections: [] },
    summary: { orders: 0, lines: 0, retainedIndependentBuildHolds: 0 }, publicationRows: [], blockers: [],
    operationalWriteAttempted: false, providerWriteAttempted: false };
}
function verification(): InventoryCutoverVerification {
  return { contractVersion: "inventory_cutover_verification_v1", activationRunId: "1", authorityRevision: "2", capturedAt: TIME,
    verificationHash: HASH, ready: true, configurationFreezeOpen: true, completedAt: null,
    expectedPublicationRows: 0, verifiedPublicationRows: 0, publicationRows: [], blockers: [],
    operationalWriteAttempted: false, providerWriteAttempted: false };
}
function render(overrides: Partial<Parameters<typeof InventoryCutoverControls>[0]> = {}) {
  return renderToStaticMarkup(createElement(InventoryCutoverControls, { actorId: "operator-1", canActivate: true,
    activationRunId: "1", runtimeAuthority: "legacy", onStateChanged: vi.fn(), ...overrides }));
}
beforeEach(() => {
  state.review = null; state.verification = null; state.error = null; state.fetching = false; state.pending = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("final cutover operator controls", () => {
  it.each([{ canActivate: false }, { actorId: null }])("hides all actions without authorized identity %j", props => {
    state.review = review();
    const html = render(props);
    expect(html).toContain("operator with inventory activation permission");
    expect(html).not.toContain("<button"); expect(html).not.toContain("<input");
  });
  it("requires explicit capture and never automatically submits a command", () => {
    expect(render()).toContain("Capture final review");
    expect(state.refetch).not.toHaveBeenCalled(); expect(state.mutate).not.toHaveBeenCalled();
    for (const [options] of vi.mocked(useQuery).mock.calls) {
      expect(options).toMatchObject({ enabled: false, retry: false, gcTime: 0 });
      expect(options.queryKey).toContain("operator-1"); expect(options.queryKey).toContain("1");
    }
  });
  it("shows concrete blockers and keeps the switch disabled", () => {
    state.review = { ...review(), ready: false, blockers: [{ code: "PENDING", subject: "target:2", message: "Await exact provider readback" }] };
    const html = render();
    expect(html).toContain("Await exact provider readback"); expect(html).toContain("target:2");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Switch to canonical authority/);
  });
  it("discloses proposed empty-bin promise handoffs without automatically applying them", () => {
    state.review = { ...review(), summary: { ...review().summary,
      legacyPromiseReplanning: { positions: 2, orderLines: 3 } } };
    const html = render();
    expect(html).toContain("Re-plan 3 existing order line(s)");
    expect(html).toContain("from 2 empty-bin reservation position(s)");
    expect(html).toContain("Customer demand is retained");
    expect(html).toContain("does not change on-hand or picked stock counts");
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("does not invent a handoff for older or zero-handoff reviews", () => {
    state.review = review();
    expect(render()).not.toContain("empty-bin reservation position(s)");
    state.review = { ...review(), summary: { ...review().summary,
      legacyPromiseReplanning: { positions: 0, orderLines: 0 } } };
    expect(render()).not.toContain("empty-bin reservation position(s)");
  });
  it("does not enable mutation from stale cached data after refresh failure", () => {
    state.review = review(); state.error = new Error("Review unavailable");
    const html = render();
    expect(html).toContain('role="alert"'); expect(html).toContain("Review unavailable");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Switch to canonical authority/);
  });
  it("shows completion verification rather than any legacy switch after cutover", () => {
    state.verification = verification();
    const html = render({ runtimeAuthority: "canonical" });
    expect(html).toContain("Check full publication"); expect(html).toContain("Finish and unlock configuration");
    expect(html).not.toContain("Switch to canonical authority"); expect(html).not.toContain("Abort preparation");
  });
  it("shows historical completion without offering another mutation", () => {
    state.verification = { ...verification(), ready: false, configurationFreezeOpen: false, completedAt: TIME };
    const html = render({ runtimeAuthority: "canonical" });
    expect(html).toContain("Cutover completed"); expect(html).not.toContain("<input");
    expect(html).not.toContain("Finish and unlock configuration</button>");
  });
  it("bounds DOM records without truncating the reviewed whole catalog", () => {
    state.review = { ...review(), publicationRows: Array.from({ length: 50_000 }, (_, index) => ({
      publicationTargetId: 1, productVariantId: index + 1, desiredQuantity: String(index + 1),
    })) };
    const html = render();
    expect(html).toContain("Page 1 of 2500"); expect(html).toContain("50000 total");
    expect((html.match(/<tr>/g) ?? []).length).toBe(21);
  });
  it("rejects bypassed mutation handlers when permission is denied", async () => {
    render({ canActivate: false });
    for (const [options] of vi.mocked(useMutation).mock.calls) {
      await expect(options.mutationFn!({} as never, {} as never)).rejects.toThrow("authorized operator");
    }
  });
});

describe("cutover command HTTP boundary", () => {
  const schema = z.object({ ok: z.literal(true) }).strict();
  it("sends only the supplied authenticated command and disables response caching", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await expect(postCutoverCommand("review", { activationRunId: "1" }, schema, signal)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/inventory-planning/admin/cutover/review", {
      method: "POST", credentials: "include", cache: "no-store", signal,
      headers: { "Content-Type": "application/json" }, body: '{"activationRunId":"1"}',
    });
  });
  it("preserves an explicit stale-evidence rejection for same-command recovery handling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "CUTOVER_REVIEW_CHANGED", message: "Capture again" } }), { status: 409 })));
    await expect(postCutoverCommand("commit", {}, schema)).rejects.toMatchObject({ status: 409, code: "CUTOVER_REVIEW_CHANGED" });
  });
  it.each(["invalid-json", '{"ok":false}', '{"ok":true,"unexpected":1}'])("never reports success for unchecked response %s", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(payload, { status: 200 })));
    await expect(postCutoverCommand("finish", {}, schema)).rejects.toThrow(/verified|validation/);
  });
  it("does not hide an uncertain network outcome or synthesize successful replay", async () => {
    const failure = new Error("Connection lost");
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    await expect(postCutoverCommand("finish", {}, schema)).rejects.toBe(failure);
  });
});
