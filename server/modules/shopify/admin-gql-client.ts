/**
 * Shopify Admin GraphQL Client — typed, injectable wrapper.
 *
 * Plan §6 Commit 21 — scaffolds the seam used by the fulfillment-push
 * service to call `fulfillmentCreateV2` and `fulfillmentOrders` against
 * the Shopify Admin API.
 *
 * Design notes (per coding-standards Rule #1 architecture / #11 no magic):
 *
 *   - The interface (`ShopifyAdminGraphQLClient`) is what consumers depend
 *     on. Tests pass a mock that implements `request<T>()`. Production
 *     wires `createDefaultShopifyAdminClient()` which delegates to the
 *     existing `shopifyGraphQL` adapter (server/modules/subscriptions/
 *     infrastructure/shopify.adapter.ts) so we don't duplicate the
 *     fetch / auth / version logic.
 *
 *   - The wrapper does NOT duplicate fetch/header logic — it is purely a
 *     thin DI seam. If the underlying adapter changes (API version bump,
 *     retries, telemetry), one place to update.
 *
 *   - Production service wiring injects this client into the fulfillment
 *     push service; `SHOPIFY_FULFILLMENT_PUSH_ENABLED=false` disables the
 *     ShipStation hot path when needed.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of a single Shopify GraphQL `userErrors` entry.
 */
export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

/**
 * Minimal interface the fulfillment-push service depends on. Keeping the
 * surface tiny is intentional — we only need `request` for now.
 */
export interface ShopifyAdminGraphQLClient {
  /**
   * Execute a GraphQL operation (query or mutation).
   *
   * Implementations must throw on:
   *   - Network/transport failure (non-2xx response, fetch reject)
   *   - Top-level GraphQL `errors` array non-empty
   *
   * `userErrors` inside individual mutation payloads are returned as data
   * — the caller decides whether they are fatal.
   */
  request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Default factory — delegates to the existing subscriptions adapter so we
// don't fork the auth / version / fetch logic.
// ---------------------------------------------------------------------------

/**
 * Build the default Shopify Admin GraphQL client used in production.
 *
 * Reads credentials from `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_ACCESS_TOKEN`
 * via `getShopifyConfig()` — same path subscriptions already use.
 *
 * Tests should NOT call this; pass an in-memory mock client to the
 * fulfillment-push service via `setShopifyClient(mock)` instead.
 */
export function createDefaultShopifyAdminClient(): ShopifyAdminGraphQLClient {
  return {
    async request<T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      // Lazy import keeps this file free of circular import risk and
      // means callers that never instantiate the default client do not
      // pay the import cost.
      const { shopifyGraphQL } = await import(
        "../subscriptions/infrastructure/shopify.adapter"
      );
      return shopifyGraphQL<T>(query, variables);
    },
  };
}
