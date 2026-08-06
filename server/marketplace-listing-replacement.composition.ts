import type { QueryResultRow } from "pg";

import { pool } from "./db";
import {
  EbayMarketplaceListingReplacementProvider,
  ListingReplacementExecutionService,
  ListingReplacementPlanningService,
  MarketplaceListingReplacementError,
  PgMarketplaceListingReplacementExecutionRepository,
  PgMarketplaceListingReplacementOwnerReader,
  PgMarketplaceListingReplacementRepository,
  listingOwnerRefSchema,
  type EbayListingReplacementClient,
  type EbayReplacementItemGroup,
  type ExecuteListingReplacementInput,
  type ExecuteListingReplacementResult,
  type ListingOwnerRef,
  type PlanListingReplacementResult,
} from "./modules/marketplace-listings";
import {
  EbayDropshipListingPushProvider,
  type DropshipEbayListingLifecycleClient,
} from "./modules/dropship/infrastructure/dropship-ebay-listing-push.provider";
import { PgDropshipMarketplaceCredentialRepository } from "./modules/dropship/infrastructure/dropship-marketplace-credentials";
import type { EbayInventoryItemGroup } from "./modules/channels/adapters/ebay/ebay-types";
import {
  createEbayRouteListingLifecycleClient,
  type EbayRouteListingLifecycleClient,
} from "./routes/ebay/ebay-listing-connector-client";
import { getAuthService } from "./routes/ebay/ebay-utils";
import type { MarketplaceListingReplacementServiceResolver } from "./modules/marketplace-listings/interfaces/http/listing-replacement.routes";

const EBAY_PROVIDER = "ebay";

interface DropshipOwnerRow extends QueryResultRow {
  vendor_id: number;
  platform: string;
  marketplace_config: unknown;
  listing_config_active: boolean | null;
}

export function createMarketplaceListingReplacementResolverFromEnv(): MarketplaceListingReplacementServiceResolver {
  const planning = new ListingReplacementPlanningService({
    repository: new PgMarketplaceListingReplacementRepository(pool),
    ownerReader: new PgMarketplaceListingReplacementOwnerReader(pool),
    clock: { now: () => new Date() },
  });
  const credentials = new PgDropshipMarketplaceCredentialRepository(pool);
  const dropshipEbay = new EbayDropshipListingPushProvider(credentials);
  const ebayProvider = new EbayMarketplaceListingReplacementProvider({
    async forOwner(owner) {
      if (owner.kind === "channel") {
        const auth = getAuthService();
        if (!auth) {
          throw new MarketplaceListingReplacementError(
            "MARKETPLACE_LISTING_REPLACEMENT_EBAY_AUTH_NOT_CONFIGURED",
            "eBay OAuth is not configured for the Channel owner.",
          );
        }
        const accessToken = await auth.getAccessToken(owner.channelId);
        return adaptLifecycleClient(
          createEbayRouteListingLifecycleClient({ accessToken }),
        );
      }
      const ownerRow = await loadDropshipOwner(owner.storeConnectionId);
      if (!ownerRow.listing_config_active) {
        throw new MarketplaceListingReplacementError(
          "MARKETPLACE_LISTING_REPLACEMENT_OWNER_NOT_READY",
          "Dropship eBay listing configuration is missing or inactive.",
          { storeConnectionId: owner.storeConnectionId },
        );
      }
      const marketplaceConfig = parseRecord(ownerRow.marketplace_config);
      const session = await dropshipEbay.createReplacementLifecycleClient({
        vendorId: ownerRow.vendor_id,
        storeConnectionId: owner.storeConnectionId,
        marketplaceConfig,
      });
      if (session.marketplaceId !== owner.marketplaceId) {
        throw new MarketplaceListingReplacementError(
          "MARKETPLACE_LISTING_REPLACEMENT_OWNER_BINDING_MISMATCH",
          "Dropship eBay marketplace configuration changed after planning.",
          {
            expectedMarketplaceId: owner.marketplaceId,
            actualMarketplaceId: session.marketplaceId,
          },
        );
      }
      return adaptLifecycleClient(session.client);
    },
  });
  const executionEnabled = marketplaceListingReplacementExecutionEnabled();
  const execution = new ListingReplacementExecutionService({
    repository: new PgMarketplaceListingReplacementExecutionRepository(pool),
    providers: { forOwner: () => ebayProvider },
    clock: { now: () => new Date() },
  });

  return {
    forOwner(owner: ListingOwnerRef) {
      const boundOwner = parseOwner(owner);
      return {
        async plan(input: unknown): Promise<PlanListingReplacementResult> {
          assertInputOwner(input, boundOwner);
          return planning.plan(input);
        },
        async execute(
          input: ExecuteListingReplacementInput,
        ): Promise<ExecuteListingReplacementResult> {
          assertSameOwner(input.expectedOwner, boundOwner);
          if (!executionEnabled) {
            throw new MarketplaceListingReplacementError(
              "MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_DISABLED",
              "Marketplace listing replacement execution is disabled until provider sandbox validation is complete.",
            );
          }
          return execution.execute(input);
        },
      };
    },
  };
}

async function loadDropshipOwner(
  storeConnectionId: number,
): Promise<DropshipOwnerRow> {
  const result = await pool.query<DropshipOwnerRow>(
    `SELECT sc.vendor_id, sc.platform, slc.marketplace_config, slc.is_active AS listing_config_active
     FROM dropship.dropship_store_connections sc
     LEFT JOIN dropship.dropship_store_listing_configs slc
       ON slc.store_connection_id = sc.id AND slc.platform = sc.platform
     WHERE sc.id = $1`,
    [storeConnectionId],
  );
  const row = result.rows[0];
  if (!row || row.platform !== "ebay") {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_NOT_FOUND",
      "Dropship eBay store connection was not found.",
      { storeConnectionId },
    );
  }
  return row;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_NOT_READY",
      "Dropship eBay marketplace configuration is invalid.",
    );
  }
  return value as Record<string, unknown>;
}

function adaptLifecycleClient(
  client: EbayRouteListingLifecycleClient | DropshipEbayListingLifecycleClient,
): EbayListingReplacementClient {
  return {
    getInventoryItemGroup: async (groupKey) =>
      (await client.getInventoryItemGroup(
        groupKey,
      )) as EbayReplacementItemGroup | null,
    createOrReplaceInventoryItemGroup: async (groupKey, group) => {
      const { inventoryItemGroupKey: _ignored, ...payload } = group;
      await client.createOrReplaceInventoryItemGroup(
        groupKey,
        payload as Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">,
      );
    },
    getOffers: async (sku, marketplaceId) =>
      (await client.getOffers(sku, marketplaceId)).offers.map(
        normalizeEbayReplacementOffer,
      ),
    createOffer: async (offer) => client.createOffer(offer as never),
    publishOffer: async (offerId) => client.publishOffer(offerId),
    publishOfferByInventoryItemGroup: async (groupKey, marketplaceId) =>
      client.publishOfferByInventoryItemGroup(groupKey, marketplaceId),
    withdrawOffer: async (offerId) => client.withdrawOffer(offerId),
    withdrawOfferByInventoryItemGroup: async (groupKey, marketplaceId) =>
      client.withdrawOfferByInventoryItemGroup(groupKey, marketplaceId),
  };
}

export function normalizeEbayReplacementOffer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_EBAY_RESPONSE_INVALID",
      "eBay returned an invalid offer during replacement.",
    );
  }
  const offer = value as Record<string, unknown>;
  if (typeof offer.offerId !== "string" || !offer.offerId.trim()) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_EBAY_RESPONSE_INVALID",
      "eBay returned an offer without a stable offer ID.",
    );
  }
  const listing =
    offer.listing &&
    typeof offer.listing === "object" &&
    !Array.isArray(offer.listing)
      ? (offer.listing as Record<string, unknown>)
      : null;
  const topLevelListingId = normalizedOptionalText(offer.listingId);
  const nestedListingId = normalizedOptionalText(listing?.listingId);
  if (
    topLevelListingId !== null &&
    nestedListingId !== null &&
    topLevelListingId !== nestedListingId
  ) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_EBAY_RESPONSE_INVALID",
      "eBay returned conflicting listing identities for an offer.",
      { offerId: offer.offerId.trim(), topLevelListingId, nestedListingId },
    );
  }
  const listingId = topLevelListingId ?? nestedListingId;
  return {
    ...offer,
    offerId: offer.offerId.trim(),
    ...(listingId === null ? {} : { listingId }),
  };
}

function normalizedOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function assertInputOwner(input: unknown, expected: ListingOwnerRef): void {
  if (!input || typeof input !== "object" || !("owner" in input)) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_INPUT_INVALID",
      "Marketplace listing replacement input is missing its owner.",
    );
  }
  assertSameOwner((input as { owner: ListingOwnerRef }).owner, expected);
}

function parseOwner(owner: ListingOwnerRef): ListingOwnerRef {
  const parsed = listingOwnerRefSchema.safeParse(owner);
  if (!parsed.success || parsed.data.provider !== EBAY_PROVIDER) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_INVALID",
      "Only valid eBay marketplace owners can replace a listing.",
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
  if (!same) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_BINDING_MISMATCH",
      "Replacement service is bound to a different marketplace owner.",
    );
  }
}

export function marketplaceListingReplacementExecutionEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    environment.MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED === "true"
  );
}
