import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WalmartChannelService } from "./modules/channels/adapters/walmart/walmart-channel.service";
import { WalmartListingLifecycleProvider } from "./modules/channels/adapters/walmart/walmart-listing-lifecycle.provider";
import { InventoryPublicationTargetVariantHoldService } from "./modules/inventory-planning/application/inventory-publication-target-variant-hold.service";
import { PostgresInventoryPublicationTargetVariantHoldStore } from "./modules/inventory-planning/infrastructure/inventory-publication-target-variant-hold.repository";
import { ListingLifecycleService } from "./modules/marketplace-listings/application/listing-lifecycle.service";
import { PostgresListingLifecycleRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-lifecycle.repository";

export function createListingLifecycleService(
  pool: Pick<Pool, "connect">,
  walmart: WalmartChannelService,
  store: PostgresListingLifecycleRepository,
): ListingLifecycleService {
  return new ListingLifecycleService({
    store,
    provider: new WalmartListingLifecycleProvider(
      walmart,
      new InventoryPublicationTargetVariantHoldService(
        new PostgresInventoryPublicationTargetVariantHoldStore(pool),
      ),
    ),
    now: () => new Date(),
    uuid: randomUUID,
  });
}
