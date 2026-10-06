import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WalmartChannelService } from "./modules/channels/adapters/walmart/walmart-channel.service";
import { WalmartListingUpdateProvider } from "./modules/channels/adapters/walmart/walmart-listing-update.provider";
import { ListingUpdateService } from "./modules/marketplace-listings/application/listing-update.service";
import { PostgresListingUpdateRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-update.repository";

export function createListingUpdateService(
  pool: Pick<Pool, "connect">,
  walmart: WalmartChannelService,
): ListingUpdateService {
  return new ListingUpdateService({
    store: new PostgresListingUpdateRepository(pool),
    provider: new WalmartListingUpdateProvider(walmart),
    now: () => new Date(),
    uuid: randomUUID,
  });
}
