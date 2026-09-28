import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { DropshipCostChangeActivityPanel } from "../dropship-cost-change-activity-panel";
import type {
  DropshipCostChangeDetectionOverview,
  DropshipCostChangeLogPage,
  DropshipCostChangeLogRowView,
  DropshipCostPendingChangeView,
} from "../dropship-cost-change-policy-model";

const queries = vi.hoisted(() => ({
  states: [] as Array<Record<string, unknown>>,
  index: 0,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => {
    const state = queries.states[queries.index] ?? {};
    queries.index += 1;
    return { data: undefined, error: null, isLoading: false, isFetching: false, isError: false, refetch: () => Promise.resolve(), ...state };
  }),
}));

beforeEach(() => {
  queries.states = [];
  queries.index = 0;
  vi.clearAllMocks();
});

const pending: DropshipCostPendingChangeView = {
  entryId: 11, recordedBy: "detection", vendorId: 5, vendorBusinessName: "Shellz Vendor", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
  variantName: "Single pack", productName: "Armor Envelope", policyId: 2, costSource: "plan_percent",
  effectiveAt: "2026-10-13T00:00:00.000Z", observedAt: "2026-09-28T16:05:00.000Z", kind: "increase", fromCents: 809, unitCostCents: 999,
};

const logRow: DropshipCostChangeLogRowView = {
  logId: 31, entryId: 11, recordedBy: "acceptance", vendorId: 5, vendorBusinessName: null, productVariantId: 66, variantSku: null, variantName: "Single pack",
  productName: "Armor Envelope", policyId: null, costSource: "retail", effectiveAt: "2026-10-13T00:00:00.000Z",
  observedAt: "2026-09-28T16:05:00.000Z", eventType: "change_withdrawn", fromCents: 1099, toCents: null, retailDriven: true,
  createdAt: "2026-09-28T16:05:00.000Z",
};

function detection(patch: Partial<DropshipCostChangeDetectionOverview> = {}): DropshipCostChangeDetectionOverview {
  return {
    workerEnabled: true,
    state: {
      passNumber: 3, passStartedAt: "2026-09-28T09:00:00.000Z", passCompletedAt: "2026-09-28T09:01:00.000Z", cursorVendorId: null,
      policyId: 2, passVendorsProcessed: 4, passVariantsRead: 120, passUnavailableReadings: 1, passChangesRecorded: 2,
      lastTickAt: "2026-09-28T09:59:00.000Z",
    },
    pending: [pending],
    pendingLimit: 200,
    generatedAt: "2026-09-28T10:00:00.000Z",
    ...patch,
  };
}

function render(states: Array<Record<string, unknown>>): string {
  queries.states = states;
  queries.index = 0;
  return renderToStaticMarkup(createElement(DropshipCostChangeActivityPanel));
}

function section(html: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const part = html.split("<section").find((candidate) => candidate.slice(0, candidate.indexOf(">")).includes(marker));
  expect(part, `no <section> carries ${marker}`).toBeDefined();
  return part ?? "";
}

const log = (items: DropshipCostChangeLogRowView[], nextBeforeId: number | null = null): DropshipCostChangeLogPage =>
  ({ items, nextBeforeId, generatedAt: "2026-09-28T10:00:00.000Z" });

describe("dropship cost change activity panel", () => {
  it("reads the detection view and the first log page, and nothing else", () => {
    render([{ data: detection() }, { data: log([]) }]);
    const calls = vi.mocked(useQuery).mock.calls.map((call) => call[0]);
    expect(calls[0]).toMatchObject({ queryKey: ["/api/dropship/admin/cost-changes/detection"] });
    expect(calls[1]).toMatchObject({ queryKey: ["/api/dropship/admin/cost-changes/log?limit=50"] });
    expect(calls).toHaveLength(2);
  });

  it("shows the last pass and every announced change with its vendor, variant, amounts and date", () => {
    const html = render([{ data: detection() }, { data: log([]) }]);
    const detectionSection = section(html, "cost-change-detection");
    expect(detectionSection).toContain("Up to date");
    expect(detectionSection).toContain("Last detection pass completed");
    expect(detectionSection).toContain("Pass 3: 4 vendors, 120 variant readings, 2 changes recorded, 1 reading unavailable.");
    expect(detectionSection).toContain('data-testid="cost-change-pending-11"');
    expect(detectionSection).toContain("Shellz Vendor");
    expect(detectionSection).toContain("ARM-ENV-SGL-P50 · Armor Envelope");
    expect(detectionSection).toContain("$8.09 → $9.99");
    expect(detectionSection).toContain("Plan percentage of retail");
    expect(detectionSection).toContain("Increase");
    expect(detectionSection).toContain("by detection");
    expect(detectionSection).not.toContain("Only the first");
  });

  it("says when the worker is off here, and when nothing is announced or recorded", () => {
    const html = render([
      { data: detection({ workerEnabled: false, pending: [], state: { ...detection().state, passStartedAt: null, passCompletedAt: null, passNumber: 0 } }) },
      { data: log([]) },
    ]);
    const detectionSection = section(html, "cost-change-detection");
    expect(detectionSection).toContain("Worker off here");
    expect(detectionSection).toContain("The detection worker is switched off in this environment, so no cost is being checked here.");
    expect(detectionSection).toContain("No cost change is announced.");
    expect(section(html, "cost-change-log")).toContain("Nothing has been recorded yet.");
    expect(html).not.toContain('data-testid="cost-change-log-older"');
  });

  it("notes when the announced list is cut at the server's limit", () => {
    const many = Array.from({ length: 3 }, (_, index) => ({ ...pending, entryId: index + 1 }));
    const html = render([{ data: detection({ pending: many, pendingLimit: 3 }) }, { data: log([]) }]);
    expect(section(html, "cost-change-detection")).toContain("Only the first 3 announced changes are listed.");
  });

  it("lists log rows newest first with the event, amounts, retail badge and policy, and offers older rows", () => {
    const html = render([{ data: detection() }, { data: log([logRow, { ...logRow, logId: 30, eventType: "baseline", fromCents: null, toCents: 809, retailDriven: false, policyId: 2 }], 30) }]);
    const logSection = section(html, "cost-change-log");
    expect(logSection.indexOf('data-testid="cost-change-log-31"')).toBeLessThan(logSection.indexOf('data-testid="cost-change-log-30"'));
    expect(logSection).toContain("Announced change withdrawn");
    expect(logSection).toContain("$10.99 withdrawn");
    expect(logSection).toContain("Retail price move");
    expect(logSection).toContain("Vendor 5 · Single pack · Armor Envelope · Retail price");
    expect(logSection).toContain("Default policy");
    expect(logSection).toContain("at order acceptance");
    expect(logSection).toContain("Schedule started");
    expect(logSection).toContain("$8.09");
    expect(logSection).toContain("Policy version id 2");
    expect(logSection).toContain('data-testid="cost-change-log-older"');
    expect(logSection).toContain("Show older");
  });

  it("says a failed read failed, for each of the two reads", () => {
    const html = render([
      { isError: true, error: new Error("Request failed with 503") },
      { isError: true, error: new Error("Request failed with 500") },
    ]);
    expect(section(html, "cost-change-detection")).toContain("Request failed with 503");
    expect(section(html, "cost-change-log")).toContain("Request failed with 500");
  });

  it("shows a loading state before either read answers", () => {
    const html = render([{ isLoading: true }, { isLoading: true }]);
    expect(html).toContain("Loading detection results…");
    expect(html).toContain("Loading the change log…");
  });
});
