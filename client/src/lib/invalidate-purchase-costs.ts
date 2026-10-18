import type { QueryClient } from "@tanstack/react-query";

/** A supplier or receipt update can affect multiple shipments and their POs.
 * Invalidate the same read surfaces even when a response is lost after commit. */
export function invalidatePurchaseCosts(
  queryClient: QueryClient,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      return (
        typeof key === "string" &&
        (/^\/api\/purchase-orders(?:\/|\?|$)/.test(key) ||
          /^\/api\/inbound-shipments(?:\/|\?|$)/.test(key) ||
          /^\/api\/receiving(?:\/|\?|$)/.test(key) ||
          /^\/api\/vendor-invoices(?:\/|\?|$)/.test(key) ||
          /^\/api\/vendor-invoice-lines(?:\/|\?|$)/.test(key) ||
          /^\/api\/procurement\/health(?:\?|$)/.test(key) ||
          key.startsWith("/api/procurement/landed-cost-health") ||
          key.startsWith("/api/inventory-lots/") ||
          key === "/api/cogs/historical-adjustments" ||
          key.startsWith("/api/purchasing/dashboard"))
      );
    },
  });
}
