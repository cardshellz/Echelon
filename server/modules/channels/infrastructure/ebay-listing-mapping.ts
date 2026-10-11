import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { pool } from "../../../db";
import { PgMarketplaceListingRegistrationRepository } from "../../marketplace-listings";
import { EbayListingMappingService } from "../ebay-listing-mapping.service";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import { createEbayAuthConfig, EbayAuthService } from "../adapters/ebay/ebay-auth.service";
import { createEbayMarketplaceRegistrationAdapters } from "../adapters/ebay/ebay-marketplace-registration.factory";
import { EBAY_CHANNEL_ID, getAuthService } from "./ebay-api-runtime";
import { readExistingEbayListingMappingIdentity, readExistingEbayListingMappingSource } from "./ebay-active-listing-sync";
import { PostgresEbayListingMappingRepairRepository } from "./ebay-listing-mapping.repository";

const canonicalRegistration = new PgMarketplaceListingRegistrationRepository(pool);
const store = new PostgresEbayListingMappingRepairRepository(pool, {
  channelId: EBAY_CHANNEL_ID,
  canonicalRegistration,
  readSourceInsideTransaction: async (client, productId) => {
    const database = drizzle(client, { schema });
    // Re-read saved account and catalog state on the same connection as the
    // repair. This helper performs no provider request or quantity calculation.
    const authService = new EbayAuthService(database, createEbayAuthConfig());
    const snapshot = await readExistingEbayListingMappingIdentity(productId, { database, authService });
    return {
      identity: snapshot.identity,
      environment: snapshot.environment,
      candidates: snapshot.identity.variants.map(member => ({
        productVariantId: member.variantId,
        sku: member.sku,
        isActive: snapshot.rows.find(row => row.variant_id === member.variantId)!.variant_is_active,
      })),
    };
  },
});

export const ebayListingMappingService = new EbayListingMappingService({
  readSource: readExistingEbayListingMappingSource,
  inspect: async input => {
    const authService = getAuthService();
    if (!authService) throw new EbayListingSyncError("EBAY_SYNC_AUTH_REQUIRED", "Connect the intended eBay seller account before checking this listing.");
    return createEbayMarketplaceRegistrationAdapters({ authService }).inspector.inspectExistingPublication(input);
  },
  assertCompatible: async (source, observation, provenIdentity) => {
    await canonicalRegistration.assertCompatiblePublication({
      owner: { kind: "channel", channelId: source.identity.channelId, productId: source.identity.productId,
        provider: "ebay", marketplaceId: source.identity.marketplaceId },
      observation,
      memberCandidates: source.candidates,
    });
    // Use the same ownership check as the applying transaction so a known
    // conflicting product is explained before an Apply button is offered.
    await store.checkMappingOwnership(provenIdentity);
  },
  store,
  reportDiagnosticFailure: event => {
    console.error(JSON.stringify({ event: "ebay_listing_mapping_check_failed", ...event }));
  },
  now: () => new Date(),
});
