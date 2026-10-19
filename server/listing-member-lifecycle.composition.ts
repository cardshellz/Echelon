import type { Pool } from "pg";
import { z } from "zod";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import { EbayAuthService, createEbayAuthConfig } from "./modules/channels/adapters/ebay/ebay-auth.service";
import { EbayApiClient } from "./modules/channels/adapters/ebay/ebay-api.client";
import { assertEbayQuantityAcknowledgement } from "./modules/channels/adapters/ebay/ebay-inventory-quantity";
import { WalmartListingMemberAdapter } from "./modules/channels/adapters/walmart/walmart-listing-member.adapter";
import type { WalmartListingLifecycleProvider } from "./modules/channels/adapters/walmart/walmart-listing-lifecycle.provider";
import { PgDropshipMarketplaceCredentialRepository } from "./modules/dropship/infrastructure/dropship-marketplace-credentials";
import { RefreshingDropshipEbayRegistrationCredentialProvider } from "./modules/dropship/infrastructure/dropship-ebay-registration-credentials";
import { createChannelEbayQuantityRequestAdmission, createDropshipEbayQuantityRequestAdmission } from "./modules/inventory-planning/quantity-publication";
import { ListingMemberLifecycleError } from "./modules/marketplace-listings/domain/listing-member-lifecycle";
import { EbayListingMemberAdapter } from "./modules/marketplace-listings/infrastructure/providers/ebay/ebay-listing-member.adapter";
import { ShopifyListingMemberAdapter } from "./modules/marketplace-listings/infrastructure/providers/shopify-listing-member.adapter";
import { PostgresListingMemberLifecycleRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-member-lifecycle.repository";
import type { ListingMemberLifecycleDependencies, ListingMemberLifecycleAdapter } from "./modules/marketplace-listings/application/listing-member-lifecycle.port";
import type { ListingLifecycleStore } from "./modules/marketplace-listings/application/listing-lifecycle-ports";
import type { EbayQuantityRequestAdmission } from "./modules/channels/quantity-publication-request";

const directConnectionSchema = z.object({
  provider: z.string(),
  shop_domain: z.string().nullable(),
  access_token: z.string().nullable(),
  api_version: z.string().nullable(),
});

/** Composition chooses credential owners. Eligibility, retries and completion
 * stay in marketplace-listings; neither adapter owns an ATP calculation. */
export function createListingMemberLifecycle(pool: Pick<Pool, "connect">, walmart: WalmartListingLifecycleProvider,
  authDatabase: ConstructorParameters<typeof EbayAuthService>[0], publicationStore: ListingLifecycleStore): ListingMemberLifecycleDependencies {
  const dropshipCredentials = new PgDropshipMarketplaceCredentialRepository(pool);
  const dropshipEbay = RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(dropshipCredentials);
  async function directConnection(identity: ListingMemberIdentity) {
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT cc.shop_domain,cc.access_token,cc.api_version,lower(c.provider) AS provider
        FROM channels.channel_connections cc JOIN channels.channels c ON c.id=cc.channel_id WHERE cc.id=$1 AND cc.channel_id=$2`,
      [identity.connectionId, identity.channelId]);
      if (result.rowCount !== 1) throw accountChanged();
      const connection = directConnectionSchema.parse(result.rows[0]);
      if (connection.provider !== identity.provider) throw accountChanged();
      return connection;
    } finally { client.release(); }
  }
  const ebay = new EbayListingMemberAdapter(async identity => {
    let token: string;
    let admission: EbayQuantityRequestAdmission;
    if (identity.destinationKind === "channel_connection") {
      await directConnection(identity);
      const config = createEbayAuthConfig();
      if (config.environment !== identity.environment) throw accountChanged();
      const auth = new EbayAuthService(authDatabase, config);
      const account = await auth.getVerifiedProviderAccount(identity.channelId!);
      if (account?.externalAccountId !== identity.accountId) throw accountChanged();
      token = await auth.getAccessToken(identity.channelId!);
      admission = await createChannelEbayQuantityRequestAdmission({ channelId: identity.channelId!,
        expectedConnectionId: identity.connectionId, externalAccountId: identity.accountId! });
    } else {
      if (!identity.vendorId) throw accountChanged();
      const credential = await dropshipEbay.loadFreshForStoreConnection({ vendorId: identity.vendorId, storeConnectionId: identity.connectionId,
        operation: "listing-member-retirement" });
      if (credential.externalAccountId !== identity.accountId || credential.providerEnvironment !== identity.environment) throw accountChanged();
      token = credential.accessToken;
      admission = createDropshipEbayQuantityRequestAdmission({ storeConnectionId: identity.connectionId,
        externalAccountId: credential.externalAccountId, externalAccountVerifiedAt: credential.externalAccountVerifiedAt });
    }
    const client = new EbayApiClient({ getAccessToken: async () => token }, identity.channelId ?? identity.connectionId,
      identity.environment, { quantityAdmission: async () => admission });
    return { getOffer: id => client.getOffer(id), deleteOffer: id => client.deleteOffer(id),
      clearOffer: async (offerId, sku) => {
        const response = await client.bulkUpdatePriceQuantity({ requests: [{ sku, offers: [{ offerId, availableQuantity: 0 }] }] }, identity.market);
        assertEbayQuantityAcknowledgement(response, sku, offerId);
      } };
  });
  const shopify = new ShopifyListingMemberAdapter(async identity => {
    let domain: string | null;
    let token: string;
    let version: string;
    if (identity.destinationKind === "channel_connection") {
      const connection = await directConnection(identity);
      if (!connection.access_token) throw accountChanged();
      domain = connection.shop_domain;
      token = connection.access_token;
      version = connection.api_version || "2026-04";
    } else {
      if (!identity.vendorId) throw accountChanged();
      const credential = await dropshipCredentials.loadForStoreConnection({ vendorId: identity.vendorId, storeConnectionId: identity.connectionId, platform: "shopify" });
      domain = credential.shopDomain; token = credential.accessToken;
      version = typeof credential.config.apiVersion === "string" ? credential.config.apiVersion : "2026-04";
    }
    if (domain !== identity.accountId || !domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)
      || !token || !/^20\d\d-(01|04|07|10)$/.test(version)) throw accountChanged();
    return { graphql: async (query, variables) => {
      if (query.startsWith("mutation") && process.env.DRY_RUN === "true")
        throw new ListingMemberLifecycleError("LISTING_MEMBER_DRY_RUN", "Listing removal is disabled while dry run is enabled.");
      const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(25_000) });
      if (!response.ok) throw new ListingMemberLifecycleError("LISTING_MEMBER_PROVIDER_UNAVAILABLE",
        `Shopify returned HTTP ${response.status}. Check the connection and retry.`,
        response.status >= 500 || response.status === 408 ? "unknown" : "not_submitted");
      const body: unknown = await response.json();
      const envelope = z.object({ errors: z.array(z.unknown()).optional() }).passthrough().parse(body);
      if (envelope.errors?.length) throw new ListingMemberLifecycleError("LISTING_MEMBER_PROVIDER_REJECTED",
        "Shopify did not confirm a complete response. Check the connection permissions and listing status.",
        query.startsWith("mutation") ? "unknown" : "not_submitted");
      return body;
    } };
  });
  const walmartAdapter = new WalmartListingMemberAdapter(walmart);
  const adapters = new Map<string, ListingMemberLifecycleAdapter>([ ["ebay", ebay], ["shopify", shopify], ["walmart", walmartAdapter] ]);
  return { store: new PostgresListingMemberLifecycleRepository(pool),
    withPublicationFence: async (identity, work) => {
      if (identity.provider !== "walmart") return work(false);
      return publicationStore.withListing(await walmartAdapter.account(identity), identity.externalSku!,
        async session => work(await session.hasPendingFeed(identity.externalSku!)));
    },
    adapter: async identity => {
      if (!identity.accountId || identity.identityConflict)
        throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_INCOMPLETE", "The saved listing has conflicting IDs or no verified seller account. Repair that variant's connection.");
      const adapter = adapters.get(identity.provider);
      if (!adapter) throw new ListingMemberLifecycleError("LISTING_MEMBER_PROVIDER_UNSUPPORTED", "This sales channel does not support automatic variant removal yet.");
      return adapter;
    },
  };
}
function accountChanged() { return new ListingMemberLifecycleError("LISTING_MEMBER_ACCOUNT_CHANGED", "The connected seller account differs from this saved removal request. Reconnect the intended account or repair the listing link."); }
