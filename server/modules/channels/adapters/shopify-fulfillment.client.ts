import type { ShopifyAdminGraphQLClient } from "../../shopify/admin-gql-client";
import type { ShopifyIdentityConnection } from "./shopify-identity.reader";
import { ChannelFulfillmentProviderError } from "../channel-fulfillment-provider.error";
import {
  isShopifyAdminGraphQLConnectionValid,
  requestShopifyAdminGraphQL,
  type ShopifyAdminGraphQLFailure,
} from "./shopify-admin-graphql.core";

const REQUEST_TIMEOUT_MS = 15_000;
const TRANSIENT_GRAPHQL_CODES: ReadonlySet<string> = new Set(["THROTTLED", "INTERNAL_SERVER_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"]);

/**
 * The fulfillment write-back's error for each core failure. Codes, messages and classes are the ones this client
 * threw before the request path moved into the shared core (PLAN-CH2 v4.1 §6.1, SAF-14); its unit tests pin them.
 */
function fulfillmentError(failure: ShopifyAdminGraphQLFailure): ChannelFulfillmentProviderError {
  switch (failure.kind) {
    case "connection_invalid":
      return new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_CONNECTION_INVALID", "Shopify fulfillment connection is invalid");
    case "transport":
      return new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_TRANSPORT_FAILED", "Shopify fulfillment request did not complete", "transient");
    case "http":
      return new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_HTTP_REJECTED", `Shopify fulfillment returned HTTP ${failure.status}`,
        failure.status === 408 || failure.status === 429 || failure.status >= 500 ? "transient" : "permanent");
    case "response_invalid":
      return new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_RESPONSE_INVALID", failure.reason === "json"
        ? "Shopify fulfillment returned invalid JSON"
        : failure.reason === "envelope" ? "Shopify fulfillment returned an invalid envelope" : "Shopify fulfillment returned no data", "transient");
    case "graphql": {
      // Never include raw provider responses or credentials in durable error logs.
      const transient = failure.codes !== null && failure.codes.length > 0
        && failure.codes.every(code => code !== null && TRANSIENT_GRAPHQL_CODES.has(code));
      return new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_GRAPHQL_REJECTED", "Shopify rejected the fulfillment GraphQL request", transient ? "transient" : "permanent");
    }
  }
}

/** Pins both domain and token for the entire fulfillment attempt. Never follows redirects. */
export function createShopifyFulfillmentClient(
  connection: Pick<ShopifyIdentityConnection, "shopDomain" | "accessToken" | "apiVersion">,
  request: typeof fetch = fetch,
): ShopifyAdminGraphQLClient {
  const { shopDomain, accessToken, apiVersion } = connection;
  if (!isShopifyAdminGraphQLConnectionValid({ shopDomain, accessToken }, apiVersion)) {
    throw fulfillmentError({ kind: "connection_invalid" });
  }
  return Object.freeze({
    async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      return await requestShopifyAdminGraphQL({ shopDomain, accessToken }, { query, variables },
        { apiVersion, timeoutMs: REQUEST_TIMEOUT_MS, errorFactory: fulfillmentError }, request) as T;
    },
  });
}
