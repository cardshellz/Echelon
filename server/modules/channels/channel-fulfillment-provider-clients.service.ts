import type { ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";
import type { ChannelIdentityService } from "./channel-identity.service";
import type { IChannelStorage } from "./channels.storage";
import { ChannelIdentityError } from "./channel-identity.domain";
import { ChannelFulfillmentProviderError } from "./channel-fulfillment-provider.error";
import { createShopifyFulfillmentClient } from "./adapters/shopify-fulfillment.client";
import { EbayApiClient } from "./adapters/ebay/ebay-api.client";
import { createEbayAuthConfig, EbayAuthService, EbayProviderAccountIdentityConflictError } from "./adapters/ebay/ebay-auth.service";

const AUTHORIZATION_TIMEOUT_MS = 15_000;

export interface ShopifyFulfillmentAccount {
  readonly channelId: number;
  readonly connectionId: number;
  readonly externalAccountId: string;
  readonly client: ShopifyAdminGraphQLClient;
}

export interface ChannelFulfillmentProviderClients {
  shopify(channelId: number): Promise<ShopifyFulfillmentAccount>;
  ebay(channelId: number): Promise<Readonly<{
    channelId: number;
    externalAccountId: string;
    client: Pick<EbayApiClient, "createShippingFulfillment">;
  }>>;
}

export function createChannelFulfillmentProviderClients(dependencies: {
  channels: Pick<IChannelStorage, "getChannelById">;
  identities: Pick<ChannelIdentityService, "shopifyConnection">;
  ebayAuth: () => Pick<EbayAuthService, "getVerifiedProviderAccount" | "getAccessToken" | "observeProviderAccount" | "getEnvironment">;
  shopifyRequest?: typeof fetch;
}): ChannelFulfillmentProviderClients {
  async function requireChannel(channelId: number, provider: string): Promise<void> {
    if (!Number.isInteger(channelId) || channelId <= 0 || channelId > 2_147_483_647) {
      throw new ChannelFulfillmentProviderError("FULFILLMENT_CHANNEL_INVALID", "Fulfillment requires an exact channel identity");
    }
    const channel = await dependencies.channels.getChannelById(channelId);
    if (!channel || channel.provider?.trim().toLowerCase() !== provider) {
      throw new ChannelFulfillmentProviderError("FULFILLMENT_CHANNEL_PROVIDER_MISMATCH", "The originating channel does not match the command provider");
    }
  }
  return {
    async shopify(channelId) {
      await requireChannel(channelId, "shopify");
      let connection;
      try { connection = await dependencies.identities.shopifyConnection(channelId); } catch (error) {
        if (error instanceof ChannelIdentityError) throw new ChannelFulfillmentProviderError(error.code, error.message, error.failureClass);
        throw error;
      }
      if (connection.channelId !== channelId || !Number.isInteger(connection.id) || connection.id <= 0) {
        throw new ChannelFulfillmentProviderError("SHOPIFY_FULFILLMENT_CONNECTION_MISMATCH", "The Shopify connection does not belong to the originating channel");
      }
      return Object.freeze({ channelId, connectionId: connection.id, externalAccountId: connection.shopDomain,
        client: createShopifyFulfillmentClient(connection, dependencies.shopifyRequest) });
    },
    async ebay(channelId) {
      await requireChannel(channelId, "ebay");
      // Auth instances are channel-local: the legacy auth owner's refresh promise
      // must not be shared across different accounts.
      const auth = dependencies.ebayAuth();
      const before = await auth.getVerifiedProviderAccount(channelId);
      if (!before) throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_ACCOUNT_UNVERIFIED", "The originating eBay account needs verified OAuth identity");
      let token: string;
      let observed: Awaited<ReturnType<typeof auth.observeProviderAccount>>;
      try {
        token = await auth.getAccessToken(channelId);
        observed = await auth.observeProviderAccount(token);
      } catch (error) {
        if (error instanceof ChannelFulfillmentProviderError) throw error;
        if (error instanceof EbayProviderAccountIdentityConflictError) {
          throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_ACCOUNT_CHANGED", "The eBay credential account changed during fulfillment authorization");
        }
        // The legacy auth owner may include raw provider bodies. Do not persist
        // them in fulfillment attempts; an unavailable observation is retryable.
        throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_AUTHORIZATION_FAILED", "eBay account authorization could not be verified", "transient");
      }
      const after = await auth.getVerifiedProviderAccount(channelId);
      if (!after || before.externalAccountId !== observed.externalAccountId
        || before.externalAccountId !== after.externalAccountId
        || before.externalAccountIdentityScheme !== observed.externalAccountIdentityScheme
        || before.externalAccountIdentityScheme !== after.externalAccountIdentityScheme) {
        throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_ACCOUNT_CHANGED", "The eBay credential account changed during fulfillment authorization");
      }
      const client = new EbayApiClient({ async getAccessToken(requestedChannelId) {
        if (requestedChannelId !== channelId) throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_CHANNEL_MISMATCH", "Pinned eBay authorization belongs to another channel");
        return token;
      } }, channelId, auth.getEnvironment());
      return Object.freeze({ channelId, externalAccountId: observed.externalAccountId, client });
    },
  };
}

/** Lazy config loading keeps an unused/unconfigured eBay integration from blocking Shopify. */
export function createFulfillmentEbayAuth(
  db: ConstructorParameters<typeof EbayAuthService>[0],
  request: typeof fetch = fetch,
): EbayAuthService {
  let config;
  try { config = createEbayAuthConfig(); } catch {
    throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_CONFIG_MISSING", "eBay fulfillment OAuth configuration is unavailable");
  }
  return new EbayAuthService(db, config, { fetch: async (input, init) => {
    let response: Response;
    try {
      response = await request(input, {
        ...init, redirect: "error", signal: AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS),
      });
    } catch {
      throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_AUTHORIZATION_FAILED", "eBay account authorization did not complete", "transient");
    }
    if (!response.ok) {
      throw new ChannelFulfillmentProviderError("EBAY_FULFILLMENT_AUTHORIZATION_REJECTED", `eBay account authorization returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500 ? "transient" : "permanent");
    }
    return response;
  } });
}
