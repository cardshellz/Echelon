import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ListingPublicationService } from "./modules/marketplace-listings/application/listing-publication.service";
import { ListingPublicationError } from "./modules/marketplace-listings/domain/listing-publication";
import { PostgresListingPublicationRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-publication.repository";
import { ChannelListingCatalogRepository } from "./modules/channels/channel-listing-catalog.repository";
import { WalmartListingProvider } from "./modules/channels/adapters/walmart/walmart-listing.provider";
import type { WalmartChannelService } from "./modules/channels/adapters/walmart/walmart-channel.service";
import type { ChannelCatalogDirectory } from "./modules/channels/channel-catalog.routes";
import type { QuantityPublicationAdmission } from "./modules/inventory-planning/application/quantity-publication-admission.port";
import { createCatalogPublicImageUrl } from "./modules/catalog/catalog-public-image";

/** The composition root connects existing owners; none owns another module's tables. */
export function createListingPublicationService(input: {
  pool: Pick<Pool, "connect">;
  walmart: WalmartChannelService;
  channelCatalog: ChannelCatalogDirectory;
  quantityAdmission: QuantityPublicationAdmission;
}): ListingPublicationService {
  const provider = new WalmartListingProvider(input.walmart);
  return new ListingPublicationService({
    store: new PostgresListingPublicationRepository(input.pool),
    catalog: new ChannelListingCatalogRepository(input.pool, createCatalogPublicImageUrl(process.env)),
    provider: async (channelId) => {
      await provider.account(channelId);
      return provider;
    },
    identities: (channelId) => input.channelCatalog.forChannel(channelId),
    inventory: {
      inspect: async (account, items) => {
        const inspection =
          await input.quantityAdmission.inspectListingSetupZero({
            channelId: account.channelId,
            channelConnectionId: account.connectionId,
            partnerId: account.accountId,
            environment: account.environment,
            shipNodeId: account.scopeId,
            items: items.map((item) => ({
              productVariantId: item.variantId,
              sku: item.sku,
              quantity: 0,
            })),
          });
        return {
          ready: inspection.ready,
          targetId: inspection.publicationTargetId?.toString() ?? null,
          targetRevision: inspection.targetRevision,
          message: inspection.ready
            ? "Items will be created with zero stock. Review their stock mappings in Channel Inventory after acceptance."
            : [
                ...new Set([
                  ...inspection.blockers.map((blocker) => blocker.message),
                  ...inspection.variants.flatMap((variant) =>
                    variant.blockers.map((blocker) => blocker.message),
                  ),
                ]),
              ].join(" ") ||
              "Complete the Walmart destination in Channel Inventory.",
        };
      },
      submitZero: async (
        account,
        operationId,
        items,
        reviewedInventory,
        submit,
      ) => {
        if (!reviewedInventory.targetId || !reviewedInventory.targetRevision) {
          throw new ListingPublicationError(
            "LISTING_INVENTORY_REVIEW_MISSING",
            "Review the exact inventory destination before publishing",
          );
        }
        return input.quantityAdmission.runListingSetupZero(
          {
            operationId,
            publicationTargetId: Number(reviewedInventory.targetId),
            expectedTargetRevision: reviewedInventory.targetRevision,
            channelId: account.channelId,
            channelConnectionId: account.connectionId,
            partnerId: account.accountId,
            environment: account.environment,
            shipNodeId: account.scopeId,
            items: items.map((item) => ({
              productVariantId: item.variantId,
              sku: item.sku,
              quantity: 0,
            })),
          },
          submit,
        );
      },
    },
    now: () => new Date(),
    uuid: randomUUID,
  });
}
