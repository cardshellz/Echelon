import type { QueryClient } from "@tanstack/react-query";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";

/** An unknown response can hide a committed physical return. Refresh the same
 * inventory and source views after every attempted command, including recovery. */
export async function invalidateSupplierReturns(client: QueryClient): Promise<void> {
  await Promise.all([
    invalidatePurchaseCosts(client),
    client.invalidateQueries({ predicate: query => {
      const key = query.queryKey[0];
      return typeof key === "string" && (
        /^\/api\/supplier-(?:returns|return-entitlements|credits)(?:[/?]|$)/.test(key)
        || /^\/api\/inventory(?:[/?-]|$)/.test(key)
        || /^\/api\/warehouse\/locations(?:[/?]|$)/.test(key)
        || /^\/api\/products\/\d+\/inventory$/.test(key)
        || /^\/api\/operations\/(?:bin-inventory|unassigned-inventory|location-health|pick-replen-health|action-queue)(?:[/?]|$)/.test(key));
    } }),
  ]);
}
