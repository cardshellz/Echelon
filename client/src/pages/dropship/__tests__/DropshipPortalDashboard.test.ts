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

  it("marks held orders in the recent list and counts them on the Orders metric", () => {
    expect(source).toContain("const heldDetail = describeHeldOrder(order, now);");
    expect(source).toContain('data-testid="recent-order-hold-detail"');
    expect(source).toContain("`${heldCount} waiting on payment`");
  });
});
