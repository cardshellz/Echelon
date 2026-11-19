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
 *     neutral `shopifyGraphQL` transport owned by this module (COM-06 / C-B5).
 *
 *   - Production service wiring injects this client into the fulfillment
 *     push service; `SHOPIFY_FULFILLMENT_PUSH_ENABLED=false` disables the
 *     ShipStation hot path when needed.
 */

import { getShopifyConfig } from "../integrations/shopify";

export const SHOPIFY_API_VERSION = "2024-10";

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

export interface ShopifyGraphQLRequestOptions {
  apiVersion?: string;
  timeoutMs?: number;
}

export interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
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

/**
 * Neutral Shopify Admin GraphQL transport execution.
 */
export async function shopifyGraphQL<T = any>(
  query: string,
  variables?: Record<string, any>,
  options: ShopifyGraphQLRequestOptions = {},
): Promise<T> {
  const version = options.apiVersion ?? SHOPIFY_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error("Invalid Shopify API version.");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("Shopify request timeout must be a positive integer.");
  }
  const config = getShopifyConfig();
  const url = `https://${config.domain}/admin/api/${version}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({ query, variables }),
    ...(options.timeoutMs === undefined
      ? {}
      : { signal: AbortSignal.timeout(options.timeoutMs) }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as ShopifyGraphQLResponse<T>;

  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return json.data as T;
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

/**
 * Build the default Shopify Admin GraphQL client used in production.
 *
 * Reads credentials from `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_ACCESS_TOKEN`
 * via `getShopifyConfig()`.
 *
 * Tests should NOT call this; pass an in-memory mock client to the
 * fulfillment-push service via `setShopifyClient(mock)` instead.
 */
export function createDefaultShopifyAdminClient(
  options: ShopifyGraphQLRequestOptions = {},
): ShopifyAdminGraphQLClient {
  return {
    async request<T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      return shopifyGraphQL<T>(query, variables, options);
    },
  };
}
