import type { ShopifyAdminGraphQLClient } from "../../shopify/admin-gql-client";
import type { ShopifyIdentityConnection } from "./shopify-identity.reader";
import { ChannelFulfillmentProviderError } from "../channel-fulfillment-provider.error";

const REQUEST_TIMEOUT_MS = 15_000;

/** Pins both domain and token for the entire fulfillment attempt. Never follows redirects. */
export function createShopifyFulfillmentClient(
  connection: Pick<ShopifyIdentityConnection, "shopDomain" | "accessToken" | "apiVersion">,
  request: typeof fetch = fetch,
): ShopifyAdminGraphQLClient {
  const { shopDomain, accessToken, apiVersion } = connection;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)
    || !/^\d{4}-\d{2}$/.test(apiVersion) || !accessToken.trim()) {
    throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_CONNECTION_INVALID", "Shopify fulfillment connection is invalid");
  }
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  return Object.freeze({
    async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      let response: Response;
      try {
        response = await request(url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_TRANSPORT_FAILED", "Shopify fulfillment request did not complete", "transient");
      }
      if (!response.ok) {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_HTTP_REJECTED", `Shopify fulfillment returned HTTP ${response.status}`,
          response.status === 429 || response.status >= 500 ? "transient" : "permanent");
      }
      let payload: unknown;
      try { payload = await response.json(); } catch {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_RESPONSE_INVALID", "Shopify fulfillment returned invalid JSON", "transient");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_RESPONSE_INVALID", "Shopify fulfillment returned an invalid envelope", "transient");
      }
      const result = payload as { data?: T; errors?: unknown };
      if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) {
        // Never include raw provider responses or credentials in durable error logs.
        const transientCodes = new Set(["THROTTLED", "INTERNAL_SERVER_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"]);
        const transient = Array.isArray(result.errors) && result.errors.length > 0 && result.errors.every((error: unknown) => {
          if (!error || typeof error !== "object" || !("extensions" in error)) return false;
          const extensions = error.extensions;
          return !!extensions && typeof extensions === "object" && "code" in extensions
            && typeof extensions.code === "string" && transientCodes.has(extensions.code.toUpperCase());
        });
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_GRAPHQL_REJECTED", "Shopify rejected the fulfillment GraphQL request", transient ? "transient" : "permanent");
      }
      if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_RESPONSE_INVALID", "Shopify fulfillment returned no data", "transient");
      }
      return result.data;
    },
  });
}
