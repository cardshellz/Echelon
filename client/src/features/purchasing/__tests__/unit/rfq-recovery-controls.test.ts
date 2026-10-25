import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RfqWorkflowPanel } from "../../RfqWorkflowPanel";
import { RfqCommandRecovery } from "../../RfqCommandRecovery";
import { createRfqRecoveryStore } from "@/lib/rfq-command";
import { rfqIntents, rfqReceipt, rfqWorkflow } from "@/lib/__tests__/fixtures/rfq-command";
import type { RfqCommands } from "../../use-rfq-commands";
const state = vi.hoisted(() => ({ commands: null as unknown, fetching: false, loadError: null as Error | null, workflow: null as unknown,
  editing: false, seededEditor: false, reviewedVersion: null as string | null, submit: vi.fn(), recover: vi.fn(), invalidate: vi.fn() }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    if (state.editing && !state.seededEditor && initial === null) { state.seededEditor = true; return [9, vi.fn()]; }
    if (typeof initial === "string" && /^[a-f0-9]{64}$/.test(initial) && state.reviewedVersion) return actual.useState(state.reviewedVersion);
    return actual.useState(initial);
  } };
});
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "operator-a" } }) }));
vi.mock("../../use-rfq-commands", () => ({ useRfqCommands: () => state.commands, invalidateRfqQueries: () => Promise.resolve() }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidate }),
  useQuery: () => ({ data: state.workflow, isPending: false, error: state.loadError, isFetching: state.fetching, refetch: vi.fn() }) }));
function commands(overrides: Partial<RfqCommands> = {}): RfqCommands {
  return { userId: "operator-a", canEdit: true, recovery: null, storageError: null, confirmed: null, pending: false, error: null,
    refresh: vi.fn(), blocked: false, recoverAllowed: false, submit: state.submit, execute: vi.fn(), recover: state.recover, ...overrides };
}
function saved() { const values = new Map<string, string>(); return createRfqRecoveryStore(() => ({ getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }), "operator-a").acquire(rfqIntents[0], () => "rfq-request-1"); }
function renderHtml(element: ReactNode) { return renderToStaticMarkup(createElement(Router, { ssrPath: "/procurement/rfqs", children: element })); }
function panel() { state.seededEditor = false; return renderHtml(createElement(RfqWorkflowPanel, { rfqId: 42 })); }
beforeEach(() => { state.commands = commands(); state.workflow = rfqWorkflow(); state.fetching = false; state.loadError = null; state.editing = false; state.reviewedVersion = null; vi.clearAllMocks(); });
describe("rendered RFQ authority and recovery controls", () => {
  it("disables an already-open quote editor when edit permission is lost", () => {
    state.editing = true; expect(panel()).toMatch(/<button[^>]*type="submit"[^>]*>Save quote revision/);
    state.commands = commands({ canEdit: false }); const html = panel();
    expect(html).toContain("Capture quote · TEST-SKU"); expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save quote revision/); expect(state.submit).not.toHaveBeenCalled();
  });
  it.each(["pending", "refreshing", "storage"])("locks open reviewed values during %s", fault => {
    state.editing = true;
    if (fault === "pending") state.commands = commands({ recovery: saved(), blocked: true });
    if (fault === "refreshing") state.fetching = true;
    if (fault === "storage") state.commands = commands({ storageError: "Recovery unavailable", blocked: true });
    expect(panel()).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save quote revision/);
  });
  it("keeps an unsubmitted quote draft visible but blocks saving against changed evidence", () => {
    state.editing = true; state.reviewedVersion = "b".repeat(64);
    const html = panel(); expect(html).toContain("Capture quote · TEST-SKU"); expect(html).toContain("Your unsaved values are retained");
    expect(html).toContain("Discard draft and review current quote");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save quote revision/);
  });
  it("keeps recovery visible when the workflow read fails", () => {
    state.commands = commands({ recovery: saved(), blocked: true, recoverAllowed: true }); state.loadError = new Error("Forbidden");
    const html = panel(); expect(html).toContain('aria-label="RFQ request recovery"'); expect(html).toContain("Recover saved RFQ request");
    expect(html).toContain("Could not refresh the quote workflow"); expect(state.recover).not.toHaveBeenCalled();
  });
  it("preserves the open quote editor after a failed refetch and disables new writes", () => {
    state.editing = true; state.loadError = new Error("Read failed"); const html = panel();
    expect(html).toContain("Capture quote · TEST-SKU"); expect(html).toContain("Could not refresh the quote workflow");
    expect(html).toContain("Use Refresh quotes"); expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save quote revision/);
    state.loadError = null; expect(panel()).toMatch(/<button[^>]*type="submit"[^>]*>Save quote revision/);
  });
  it("retains workflow drafts while the parent list evidence is unverified", () => {
    state.editing = true; state.seededEditor = false;
    const html = renderHtml(createElement(RfqWorkflowPanel, { rfqId: 42, sourceVerified: false }));
    expect(html).toContain("Capture quote · TEST-SKU"); expect(html).toContain("RFQ evidence is not currently verified");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save quote revision/);
  });
  it("renders one shared recovery region while mounted panels show separate failures", () => {
    const current = commands({ recovery: saved(), error: new Error("Response lost"), blocked: true, recoverAllowed: true });
    const html = renderHtml(createElement(Fragment, null, createElement(RfqCommandRecovery, { commands: current }),
      createElement(RfqCommandRecovery, { commands: current, showPending: false }), createElement(RfqCommandRecovery, { commands: current, showPending: false })));
    expect(html.match(/aria-label="RFQ request recovery"/g)).toHaveLength(1);
    expect(html.match(/Recover saved RFQ request/g)).toHaveLength(1); expect(html.match(/aria-label="RFQ command result"/g)).toHaveLength(2);
  });
  it("retains a read-only recovery link without allowing dispatch", () => {
    const html = renderHtml(createElement(RfqCommandRecovery, { commands: commands({ recovery: saved(), blocked: true, canEdit: false }) }));
    expect(html).toContain('href="/procurement/rfqs?rfqId=42"'); expect(html).toContain("Purchasing edit permission is required");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Recover saved RFQ request/);
  });
  it("shows shared success once while page panels keep only local error feedback", () => {
    const current = commands({ confirmed: rfqReceipt(rfqIntents[2]) });
    const html = renderHtml(createElement(Fragment, null, createElement(RfqCommandRecovery, { commands: current }),
      createElement(RfqCommandRecovery, { commands: current, showPending: false })));
    expect(html.match(/Draft created/g)).toHaveLength(1); expect(html.match(/href="\/purchase-orders\/71"/g)).toHaveLength(1);
  });
  it("links the confirmed draft returned by the preserved conversion receipt", () => {
    const html = renderHtml(createElement(RfqCommandRecovery, { commands: commands({ confirmed: rfqReceipt(rfqIntents[2]) }) }));
    expect(html).toContain('href="/purchase-orders/71"'); expect(html).toContain("PO-71"); expect(html).not.toContain("Recover saved RFQ request");
  });
});
