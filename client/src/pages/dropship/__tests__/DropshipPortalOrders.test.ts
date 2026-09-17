import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the vendor Orders page. The page is a React component
 * with browser-only dependencies, so its structure is checked from source and
 * its behavior from the browser journey in test/browser/dropship-orders.spec.ts.
 */
const source = readFileSync(join(__dirname, "..", "DropshipPortalOrders.tsx"), "utf8");

describe("DropshipPortalOrders contract", () => {
  it("asks the server what the held orders need instead of adding money up on the page", () => {
    expect(source).toContain("fetchJson<DropshipPaymentHoldSummaryResponse>(PAYMENT_HOLD_SUMMARY_PATH)");
    expect(source).toContain("describePaymentHoldSummary(holdSummaryQuery.data.summary, now, {");
    expect(source).not.toMatch(/totalDebitCents\s*-\s*availableBalanceCents/);
  });

  it("shows the waiting-on-payment banner with a way to add funds and a way to see those orders", () => {
    const banner = source.slice(source.indexOf('data-testid="orders-payment-hold-banner"'), source.indexOf("{ordersQuery.error && ("));
    expect(banner).toContain("Add funds");
    expect(banner).toContain('dropshipPortalPath("/wallet")');
    expect(banner).toContain("Show waiting orders");
    expect(banner).toContain("setApplied({ search, status: PAYMENT_HOLD_STATUS })");
  });

  it("tells a vendor paused for funding what the held orders are really waiting for", () => {
    expect(source).toContain('useQuery<DropshipOnboardingState>({');
    expect(source).toContain('queryKey: ["/api/dropship/onboarding/state"],');
    expect(source).toContain("pausedForFunding: onboardingQuery.data ? isPausedForFunding(onboardingQuery.data.vendor) : false,");
  });

  it("puts what each held order needs and how long it has under its status", () => {
    expect(source).toContain("const heldDetail = describeHeldOrder(order, now);");
    expect(source).toContain('data-testid="order-hold-detail"');
    expect(source).toContain('<DetailField label="Amount needed" value={formatCents(order.paymentHold.totalDebitCents)} />');
  });

  it("opens filtered to waiting orders when linked with ?status=, and only for statuses it offers", () => {
    expect(source).toContain("ordersStatusFilterFromSearch(window.location.search, statusOptions)");
  });

  it("refreshes the held-order summary after an order is accepted or rejected", () => {
    const occurrences = source.split("queryClient.invalidateQueries({ queryKey: [PAYMENT_HOLD_SUMMARY_PATH] })").length - 1;
    expect(occurrences).toBe(2);
  });

  it("reads one clock per data load so every countdown on the page agrees", () => {
    expect(source).toContain("const now = useMemo(() => new Date(), [holdSummaryQuery.data, ordersQuery.data]);");
    expect(source).not.toMatch(/describeHeldOrder\([^)]*new Date\(\)/);
  });
});
