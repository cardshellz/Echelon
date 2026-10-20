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
        (key === "purchase-pipeline" ||
          /^\/api\/purchasing(?:\/|\?|$)/.test(key) ||
          /^\/api\/procurement(?:\/|\?|$)/.test(key) ||
          /^\/api\/cogs(?:\/|\?|$)/.test(key) ||
          /^\/api\/finance(?:\/|\?|$)/.test(key) ||
          /^\/api\/inventory(?:\/|\?|$)/.test(key) ||
          /^\/api\/products(?:\/|\?|$)/.test(key) ||
          /^\/api\/purchase-orders(?:\/|\?|$)/.test(key) ||
          /^\/api\/inbound-shipments(?:\/|\?|$)/.test(key) ||
          /^\/api\/receiving(?:\/|\?|$)/.test(key) ||
          /^\/api\/receiving-lines(?:\/|\?|$)/.test(key) ||
          /^\/api\/shipment-lines(?:\/|\?|$)/.test(key) ||
          /^\/api\/vendor-invoices(?:\/|\?|$)/.test(key) ||
          /^\/api\/vendor-invoice-lines(?:\/|\?|$)/.test(key) ||
          /^\/api\/inventory-lots(?:\/|\?|$)/.test(key))
      );
    },
  });
}
