import { randomUUID } from "node:crypto";
import { createEbayInclusionSync } from "./ebay-inclusion-sync";
import { readEbaySyncDestination } from "./ebay-active-listing-sync";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { pool } from "../../../db";
import { createEbayAuthConfig, EbayAuthService } from "../adapters/ebay/ebay-auth.service";
import { createEbayMarketplaceRegistrationAdapters } from "../adapters/ebay/ebay-marketplace-registration.factory";
import { EBAY_CHANNEL_ID, getAuthService } from "./ebay-api-runtime";
import { readExistingEbayListingMappingIdentity } from "./ebay-active-listing-sync";
import { createEbayRouteListingLifecycleClient } from "./ebay-listing-client";
import { PostgresEbayListingExclusionRepository } from "./ebay-listing-exclusion.repository";
import { assertEbayListingSourceIdentityUnchanged } from "../ebay-existing-listing-identity";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";
import type { PreparedEbayWithdrawal } from "../ebay-listing-withdrawal.service";

export const ebayListingExclusionService = new PostgresEbayListingExclusionRepository(pool, EBAY_CHANNEL_ID, async (client, productId) => {
  const database = drizzle(client, { schema });
  const authService = new EbayAuthService(database, createEbayAuthConfig());
  return (await readExistingEbayListingMappingIdentity(productId, { database, authService })).identity;
}, () => new Date(), createEbayInclusionSync({
  pool, channelId: EBAY_CHANNEL_ID, uuid: randomUUID,
  destination: client => readEbaySyncDestination({ database: drizzle(client, { schema }),
    authService: new EbayAuthService(drizzle(client, { schema }), createEbayAuthConfig()) }),
}));

export async function prepareEbayWithdrawal(source: EbayListingSyncIdentity): Promise<PreparedEbayWithdrawal> {
  const snapshot = await readExistingEbayListingMappingIdentity(source.productId);
  assertEbayListingSourceIdentityUnchanged(source, snapshot.identity);
  const authService = getAuthService();
  if (!authService) throw new EbayListingSyncError("EBAY_SYNC_AUTH_REQUIRED", "Connect the intended eBay account before withdrawing this listing.");
  const inspector = createEbayMarketplaceRegistrationAdapters({ authService }).inspector;
  const inspect = async () => {
    const inspection = await inspector.inspectExistingPublication({
      owner: { kind: "channel", channelId: source.channelId, productId: source.productId, provider: "ebay", marketplaceId: source.marketplaceId },
      // All saved members matter even after local exclusion. These candidate
      // fields are observation metadata, not a stock decision or quantity write.
      memberCandidates: source.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, isActive: true, availableQuantity: 0 })),
    });
    const fresh = await readExistingEbayListingMappingIdentity(source.productId);
    assertEbayListingSourceIdentityUnchanged(source, fresh.identity);
    return inspection;
  };
  return { sourceIdentity: snapshot.identity, inspect,
    client: createEbayRouteListingLifecycleClient({ accessToken: await authService.getAccessToken(EBAY_CHANNEL_ID),
      expectedAccountId: source.accountId, expectedConnectionId: source.connectionId }),
  };
}
