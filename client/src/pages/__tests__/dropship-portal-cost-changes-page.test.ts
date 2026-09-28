import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import DropshipPortalCostChanges from "../dropship/DropshipPortalCostChanges";
import type { DropshipVendorCostChanges } from "@/lib/dropship-cost-changes";

const queries = vi.hoisted(() => ({ states: [] as Array<Record<string, unknown>>, index: 0 }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => {
    const state = queries.states[queries.index] ?? {};
    queries.index += 1;
    return { data: undefined, error: null, isLoading: false, isFetching: false, isError: false, refetch: () => Promise.resolve(), ...state };
  }),
}));

// The shell needs the vendor session; the page under test is what matters here.
vi.mock("../dropship/DropshipPortalShell", () => ({
  DropshipPortalShell: ({ children }: { children: unknown }) => createElement("div", { "data-testid": "shell" }, children as never),
}));

// The shadcn Skeleton has no React import of its own and vitest compiles JSX with
// the classic runtime, so rendering it under node throws "React is not defined".
// The loading state is asserted through the wrapper's aria-label, not the bars.
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => createElement("div", { className }),
}));

beforeEach(() => {
  queries.states = [];
  queries.index = 0;
  vi.clearAllMocks();
});

function view(patch: Partial<DropshipVendorCostChanges> = {}): DropshipVendorCostChanges {
  return {
    announced: [{
      entryId: 11, productVariantId: 66, variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack", productName: "Armor Envelope",
      kind: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z", announcedAt: "2026-09-28T16:00:00.000Z",
    }],
    recent: [{
      logId: 31, productVariantId: 66, variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack", productName: "Armor Envelope",
      eventType: "increase_announced", fromCents: 809, toCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z",
      observedAt: "2026-09-28T16:00:00.000Z", noticeDecision: "sent",
    }],
    listingActions: [{
      actionId: 71, entryId: 11, listingId: 2, storeConnectionId: 9, platform: "shopify", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
      variantName: "Single pack", productName: "Armor Envelope", action: "below_cost_paused", detail: null, listingPriceCents: 899, unitCostCents: 999,
      pushJobId: null, decidedAt: "2026-10-13T00:05:00.000Z", holdReleasedAt: null, holdReleaseReason: null,
    }],
    policy: { increaseNoticeDays: 14, decreaseTiming: "immediate", priceProtection: true, notifyByEmail: true, notifyInPortal: true, notifyOnDecrease: true },
    generatedAt: "2026-09-28T16:05:00.000Z",
    ...patch,
  };
}

function render(state: Record<string, unknown>): string {
  queries.states = [state];
  queries.index = 0;
  return renderToStaticMarkup(createElement(DropshipPortalCostChanges));
}

describe("vendor portal cost changes page", () => {
  it("reads the vendor's cost changes route and nothing else", () => {
    render({ data: view() });
    expect(vi.mocked(useQuery).mock.calls.map((call) => call[0])).toEqual([expect.objectContaining({ queryKey: ["/api/dropship/cost-changes"] })]);
  });

  it("shows the notice terms, the coming changes and the recent changes with their notice status", () => {
    const html = render({ data: view() });
    expect(html).toContain("You get 14 days&#x27; notice before a higher .ops cost is charged.");
    expect(html).toContain('data-testid="cost-changes-announced-11"');
    expect(html).toContain("ARM-ENV-SGL-P50 · Armor Envelope");
    expect(html).toContain("$8.09 → $9.99");
    expect(html).toContain("Increase");
    expect(html).toContain('data-testid="cost-changes-recent-31"');
    expect(html).toContain("You were notified");
    expect(html).toContain('data-testid="cost-changes-action-71"');
    expect(html).toContain("Paused: priced under the cost");
    expect(html).toContain("listed at $8.99, cost now $9.99");
    expect(html).toContain("publishes zero quantity");
  });

  it("says when nothing is coming and nothing changed", () => {
    const html = render({ data: view({ announced: [], recent: [], listingActions: [] }) });
    expect(html).toContain("No cost change is announced for your listings.");
    expect(html).toContain("Nothing changed in the last 30 days.");
    expect(html).toContain("No increase has taken effect on a live listing in the last 30 days.");
  });

  it("says a failed read failed, and shows a loading state before the read answers", () => {
    expect(render({ isError: true, error: new Error("Request failed with 503") })).toContain("Request failed with 503");
    expect(render({ isLoading: true })).toContain('aria-label="Loading cost changes"');
  });
});
