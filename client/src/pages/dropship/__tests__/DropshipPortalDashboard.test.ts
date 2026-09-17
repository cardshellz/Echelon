import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Source contract for the vendor Dashboard's held-order panel. */
const source = readFileSync(join(__dirname, "..", "DropshipPortalDashboard.tsx"), "utf8");

describe("DropshipPortalDashboard contract", () => {
  it("puts held orders above every other card, with the same server summary the Orders page uses", () => {
    expect(source).toContain("fetchJson<DropshipPaymentHoldSummaryResponse>(PAYMENT_HOLD_SUMMARY_PATH)");
    const panelUse = source.indexOf("<PaymentHoldPanel");
    const firstGrid = source.indexOf('<section className="grid gap-4 xl:grid-cols-[1.35fr_0.85fr]">');
    expect(panelUse).toBeGreaterThan(0);
    expect(panelUse).toBeLessThan(firstGrid);
  });

  it("sends the vendor to the wallet to add funds and to the orders page filtered to the waiting ones", () => {
    expect(source).toContain('onAddFunds={() => setLocation(dropshipPortalPath("/wallet"))}');
    expect(source).toContain("onViewOrders={() => setLocation(`${dropshipPortalPath(\"/orders\")}?status=${PAYMENT_HOLD_STATUS}`)}");
    const panel = source.slice(source.indexOf("function PaymentHoldPanel"), source.indexOf("function NextActionPanel"));
    expect(panel).toContain("Add funds");
    expect(panel).toContain("View waiting orders");
    expect(panel).toContain("notice.needsFunds && (");
  });

  it("puts a paused vendor's standing above the held-order panel and points the next action at the wallet", () => {
    expect(source).toContain("const standingNotice = onboarding ? describeVendorStanding(onboarding.vendor) : null;");
    const standingUse = source.indexOf("<VendorStandingPanel");
    const holdUse = source.indexOf("<PaymentHoldPanel");
    expect(standingUse).toBeGreaterThan(0);
    expect(standingUse).toBeLessThan(holdUse);
    const panel = source.slice(source.indexOf("function VendorStandingPanel"), source.indexOf("function PaymentHoldPanel"));
    expect(panel).toContain('data-testid="dashboard-vendor-standing-panel"');
    expect(panel).toContain("notice.needsFunds && (");
    expect(panel).toContain("Add funds");
    const nextAction = source.slice(source.indexOf("function dashboardNextAction"), source.indexOf("function launchStepDetail"));
    expect(nextAction.indexOf("isPausedForFunding(onboarding.vendor)")).toBeLessThan(nextAction.indexOf("onboarding.steps.find"));
    expect(nextAction).toContain('title: "Fund your wallet to resume selling"');
  });

  it("marks held orders in the recent list and counts them on the Orders metric", () => {
    expect(source).toContain("const heldDetail = describeHeldOrder(order, now);");
    expect(source).toContain('data-testid="recent-order-hold-detail"');
    expect(source).toContain("`${heldCount} waiting on payment`");
  });
});
