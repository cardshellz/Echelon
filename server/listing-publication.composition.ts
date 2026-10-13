import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ListingPublicationService } from "./modules/marketplace-listings/application/listing-publication.service";
import { ListingPublicationError } from "./modules/marketplace-listings/domain/listing-publication";
import { PostgresListingPublicationRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-publication.repository";
import { PostgresListingUpdateRepository } from "./modules/marketplace-listings/infrastructure/pg-listing-update.repository";
import { ChannelListingCatalogRepository } from "./modules/channels/channel-listing-catalog.repository";
import { WalmartListingProvider } from "./modules/channels/adapters/walmart/walmart-listing.provider";
import type { WalmartChannelService } from "./modules/channels/adapters/walmart/walmart-channel.service";
import type { ChannelCatalogDirectory } from "./modules/channels/channel-catalog.routes";
import type { QuantityPublicationAdmission } from "./modules/inventory-planning/application/quantity-publication-admission.port";
import { createCatalogPublicImageUrl } from "./modules/catalog/catalog-public-image";
import type { ListingSnapshot } from "./modules/marketplace-listings/domain/listing-publication";
import type { VerifiedListingStockService } from "./modules/inventory-planning/application/verified-listing-stock.service";
import { InventoryPublicationMembershipError } from "./modules/inventory-planning/application/inventory-publication-membership.service";
import { InventoryAvailabilityRuntimePublicationError } from "./modules/inventory-planning/application/inventory-availability-runtime-publication.service";

function recreationFor(
  variantId: number,
  sku: string,
  recreations: ListingSnapshot["recreations"],
) {
  const evidence = recreations?.find(
    (item) => item.variantId === variantId && item.sku === sku,
  );
  return evidence
    ? {
        recreation: {
          sourceOperationId: evidence.operationId,
          sourceHash: evidence.sourceHash,
          previousExternalProductId: evidence.previousExternalProductId,
        },
      }
    : {};
}

/** The composition root connects existing owners; none owns another module's tables. */
export function createListingPublicationService(input: {
  pool: Pick<Pool, "connect">;
  walmart: WalmartChannelService;
  channelCatalog: ChannelCatalogDirectory;
  quantityAdmission: QuantityPublicationAdmission;
  verifiedStock: Pick<VerifiedListingStockService, "connect">;
}): ListingPublicationService {
  const provider = new WalmartListingProvider(input.walmart);
  return new ListingPublicationService({
    store: new PostgresListingPublicationRepository(input.pool),
    listingUpdates: new PostgresListingUpdateRepository(input.pool),
    catalog: new ChannelListingCatalogRepository(
      input.pool,
      createCatalogPublicImageUrl(process.env),
    ),
    provider: async (channelId) => {
      await provider.account(channelId);
      return provider;
    },
    identities: (channelId) => input.channelCatalog.forChannel(channelId),
    inventory: {
      inspect: async (account, items, recreations) => {
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
              ...recreationFor(item.variantId, item.sku, recreations),
            })),
          });
        return {
          ready: inspection.ready,
          targetId: inspection.publicationTargetId?.toString() ?? null,
          targetRevision: inspection.targetRevision,
          message: inspection.ready
            ? "Items start with zero stock. Once Walmart publishes them, Echelon sends current available inventory automatically and checks Walmart received it. Recreated items keep their exact SKU mapping and receive a fresh stock update even if the quantity is unchanged."
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
        recreations,
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
              ...recreationFor(item.variantId, item.sku, recreations),
            })),
          },
          submit,
        );
      },
      resumeRecreationStock: async ({
        account,
        variantId,
        setupOperationId,
        sku,
        externalProductId,
        observedAt,
      }) => {
        try {
          const result = await input.verifiedStock.connect({
            channelId: account.channelId,
            connectionId: account.connectionId,
            accountId: account.accountId,
            environment: account.environment,
            externalScopeId: account.scopeId,
            productVariantId: variantId,
            setupOperationId,
            sku,
            externalProductId,
            observedAt,
            lifecycleStatus: "ACTIVE",
            publishedStatus: "PUBLISHED",
          });
          return {
            ready: result.publicationState === "verified",
            blocked: result.state === "excluded",
            message:
              result.state === "excluded"
                ? "The recreated item is published, but its channel selection excludes stock. Include this variant in the Walmart channel to resume automatic inventory updates."
                : "The recreated item is published. Current stock is queued; Echelon will confirm Walmart received it automatically. No resubmission is needed.",
          };
        } catch (error) {
          // Preserve inventory's actionable classification at the listing boundary.
          // Database/transport internals still use the application's safe fallback.
          if (
            error instanceof InventoryPublicationMembershipError ||
            error instanceof InventoryAvailabilityRuntimePublicationError
          )
            throw new ListingPublicationError(error.code, error.message);
          throw error;
        }
      },
    },
    now: () => new Date(),
    uuid: randomUUID,
  });
}
