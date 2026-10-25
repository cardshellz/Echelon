import { randomUUID } from "node:crypto";
import { createListingMemberLifecycle } from "./listing-member-lifecycle.composition";
import type { EbayAuthService } from "./modules/channels/adapters/ebay/ebay-auth.service";
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
  authDatabase: ConstructorParameters<typeof EbayAuthService>[0],
): ListingLifecycleService {
  const provider = new WalmartListingLifecycleProvider(walmart,
    new InventoryPublicationTargetVariantHoldService(new PostgresInventoryPublicationTargetVariantHoldStore(pool)));
  return new ListingLifecycleService({
    store,
    members: createListingMemberLifecycle(pool, provider, authDatabase, store),
    provider,
    now: () => new Date(),
    uuid: randomUUID,
    checkPresence: (account, sku) => walmart.observeListingPresence(account, sku),
  });
}
