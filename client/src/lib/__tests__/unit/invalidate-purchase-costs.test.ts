import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidatePurchaseCosts } from "../../invalidate-purchase-costs";

describe("cost posting cache refresh", () => {
  it("refreshes all connected documents and both dashboard health readers after a settled cost command", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const affected = [
      ["/api/purchase-orders/117"], ["/api/purchase-orders/117/shipment-costs"],
      ["/api/purchase-orders/117/workspace"], ["/api/inbound-shipments/88/cost-review"],
      ["/api/inbound-shipments/92/cost-review"], ["/api/receiving", 234],
      ["/api/vendor-invoices/139"], ["/api/vendor-invoice-lines/193/cost-components"],
      ["/api/procurement/landed-cost-health"], ["/api/procurement/health"],
      ["/api/procurement/health?includeResolved=false"], ["/api/purchasing/dashboard"],
      ["purchase-pipeline", "active"], ["/api/purchasing/reorder-analysis"], ["/api/cogs/valuation"],
      ["/api/cogs/order", 123], ["/api/inventory/levels"], ["/api/inventory/by-bin"], ["/api/products/10"],
      ["/api/purchase-orders/117/quantity-amendment/history"],
      ["/api/finance/orders", 123], ["/api/finance/summary"], ["/api/inventory-lots"],
    ];
    const unrelated = ["/api/settings/procurement"];
    for (const key of [...affected, unrelated]) client.setQueryData(key, { saved: true });
    await invalidatePurchaseCosts(client);
    for (const key of affected) expect(client.getQueryState(key)?.isInvalidated, key.join(" ")).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    // Invalidating status cannot delete cached evidence or execute a financial command.
    for (const key of affected) expect(client.getQueryData(key)).toEqual({ saved: true });
    client.clear();
  });
});
