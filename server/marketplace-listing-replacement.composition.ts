import { pool } from "./db";
import {
  ListingReplacementPlanningService,
  MarketplaceListingReplacementError,
  PgMarketplaceListingReplacementOwnerReader,
  PgMarketplaceListingReplacementRepository,
  listingOwnerRefSchema,
  type ListingOwnerRef,
  type PlanListingReplacementResult,
} from "./modules/marketplace-listings";
import type { MarketplaceListingReplacementServiceResolver } from "./modules/marketplace-listings/interfaces/http/listing-replacement.routes";

const EBAY_PROVIDER = "ebay";

export function createMarketplaceListingReplacementResolverFromEnv(): MarketplaceListingReplacementServiceResolver {
  const service = new ListingReplacementPlanningService({
    repository: new PgMarketplaceListingReplacementRepository(pool),
    ownerReader: new PgMarketplaceListingReplacementOwnerReader(pool),
    clock: { now: () => new Date() },
  });
  return {
    forOwner(owner: ListingOwnerRef) {
      const boundOwner = parseOwner(owner);
      return {
        async plan(input: unknown): Promise<PlanListingReplacementResult> {
          if (!input || typeof input !== "object" || !("owner" in input)) {
            throw new MarketplaceListingReplacementError(
              "MARKETPLACE_LISTING_REPLACEMENT_INPUT_INVALID",
              "Marketplace listing replacement input is missing its owner.",
            );
          }
          assertSameOwner(
            (input as { owner: ListingOwnerRef }).owner,
            boundOwner,
          );
          return service.plan(input);
        },
      };
    },
  };
}

function parseOwner(owner: ListingOwnerRef): ListingOwnerRef {
  const parsed = listingOwnerRefSchema.safeParse(owner);
  if (!parsed.success || parsed.data.provider !== EBAY_PROVIDER) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_INVALID",
      "Only valid eBay marketplace owners can plan a listing replacement.",
    );
  }
  return parsed.data;
}

function assertSameOwner(
  actual: ListingOwnerRef,
  expected: ListingOwnerRef,
): void {
  const parsed = parseOwner(actual);
  const same =
    parsed.kind === expected.kind &&
    parsed.productId === expected.productId &&
    parsed.marketplaceId === expected.marketplaceId &&
    parsed.provider === expected.provider &&
    (parsed.kind === "channel"
      ? expected.kind === "channel" && parsed.channelId === expected.channelId
      : expected.kind === "dropship" &&
        parsed.storeConnectionId === expected.storeConnectionId);
  if (!same)
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_BINDING_MISMATCH",
      "Replacement service is bound to a different marketplace owner.",
    );
}
