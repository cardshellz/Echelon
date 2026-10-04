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
    // What the hold needs is split by the model (rewards part, cash still needed), never added up on the page.
    expect(source).toContain("{order.paymentHold && describeHeldOrderNeed(order.paymentHold).map((part) => (");
    expect(source).not.toContain("formatCents(order.paymentHold.totalDebitCents)");
  });

  it("shows both parts of an accepted order's payment from the model, and names the rewards part after Accept (funding design phase 7)", () => {
    expect(source).toContain("const orderPayment = order ? describeOrderPayment(order) : null;");
    expect(source).toContain('data-testid="order-wallet-payment"');
    expect(source).toContain("{orderPayment.map((part) => <DetailField key={part.label} label={part.label} value={part.value} />)}");
    expect(source).not.toContain("order.walletLedgerEntry.amountCents");
    expect(source).toContain("setMessage(describeOrderAcceptance(response.result));");
    expect(source).not.toContain("function orderAcceptanceMessage");
  });

  it("shows the vendor shipping as one amount: no insurance pool line, read through the vendor order type", () => {
    const economics = source.slice(source.indexOf('title="Acceptance Economics"'), source.indexOf('title="Shipping Quote"'));
    expect(economics).toContain('<DetailField label="Shipping" value={formatCents(order.economicsSnapshot.shippingCents)} />');
    expect(economics).toContain('<DetailField label="Total debit" value={formatCents(order.economicsSnapshot.totalDebitCents)} />');
    for (const internal of ["insurancePoolCents", "Insurance pool", "baseRateCents", "markupCents", "dunnageCents", "quotePayload", "pricingSnapshot"]) {
      expect(source).not.toContain(internal);
    }
    expect(source).toContain("fetchJson<DropshipVendorOrderDetailResponse>(`/api/dropship/orders/${selectedIntakeId}`)");
    expect(source).toContain('from "@shared/dropship/vendor-order-detail";');
    expect(source).not.toContain("DropshipOrderDetailResponse");
  });

  it("shows the audit keys the vendor contract sends, from the contract's own list", () => {
    expect(source).toContain("const parts = VENDOR_ORDER_AUDIT_PAYLOAD_KEYS.flatMap((key) => {");
    expect(source).not.toMatch(/const keys = \[\s*"errorCode"/);
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
