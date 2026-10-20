import { ListingIntentLifecycleService } from "./modules/marketplace-listings/application/listing-intent-lifecycle.service";
import { PostgresListingIntentLifecycleReader } from "./modules/marketplace-listings/infrastructure/pg-listing-intent-lifecycle.reader";
import {
  ebayListingSyncService,
  syncActiveListings,
} from "./modules/channels/ebay-listing-sync";
import { EBAY_CHANNEL_ID } from "./modules/channels/infrastructure/ebay-api-runtime";
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { ListingIntentPropagationService } from "./modules/marketplace-listings/application/listing-intent-propagation.service";
import { PostgresListingIntentPropagationRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-intent-propagation.repository";
import { ExistingListingIntentHandoff } from "./modules/marketplace-listings/infrastructure/existing-listing-intent-handoff";
import { createDropshipListingPreviewServiceFromEnv } from "./modules/dropship/infrastructure/dropship-listing-preview.factory";

export const listingIntentPropagationRepository =
  new PostgresListingIntentPropagationRepository(pool);
export function createListingIntentPropagationService(): ListingIntentPropagationService {
  return new ListingIntentPropagationService({
    store: listingIntentPropagationRepository,
    handoff: new ExistingListingIntentHandoff(
      pool,
      createDropshipListingPreviewServiceFromEnv(),
      {
        channelId: EBAY_CHANNEL_ID,
        service: ebayListingSyncService,
        sync: syncActiveListings,
      },
      new ListingIntentLifecycleService(
        new PostgresListingIntentLifecycleReader(pool),
        () => new Date(),
      ),
    ),
    now: () => new Date(),
    uuid: randomUUID,
  });
}
