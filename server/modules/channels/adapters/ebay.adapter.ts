import { parseDecimalCents } from "@shared/money-read";
import { ebayBusinessPolicies } from "../ebay-business-policies";
import { EbayBusinessPolicyError } from "@shared/ebay-business-policies";
/**
 * eBay Channel Adapter
 *
 * Implements IChannelAdapter for the eBay marketplace.
 * Handles all eBay-specific API calls, payload formatting,
 * and response parsing using the eBay Sell Inventory API (REST).
 *
 * Architecture:
 * - EbayAuthService: OAuth2 token management (auto-refresh)
 * - EbayApiClient: HTTP client with retries, rate limits, DRY_RUN
 * - EbayListingBuilder: Transforms Echelon data → eBay payloads
 * - EbayCategoryMap: Product type → eBay category resolution
 *
 * Order ingestion: Push (Commerce Notification API webhook) + Poll (5-min safety net)
 */

import { eq, and } from "drizzle-orm";
import {
  channelConnections,
  channelProductOverrides,
  type ChannelConnection,
} from "@shared/schema";
import type {
  IChannelAdapter,
  ChannelListingPayload,
  ListingPushResult,
  InventoryPushItem,
  InventoryPushResult,
  InventoryPublicationContext,
  InventoryReadItem,
  InventoryReadResult,
  PricingPushItem,
  PricingPushResult,
  ChannelOrder,
  ChannelOrderLineItem,
  FulfillmentPayload,
  FulfillmentPushResult,
  CancellationPayload,
  CancellationPushResult,
} from "../channel-adapter.interface";
import { InventoryPublicationConfigurationError } from "../channel-adapter.interface";
import { QuantityPublicationAdmissionError } from "../../inventory-planning/domain/quantity-publication-admission";
import type { PublicationTransactionGuard } from "../../inventory-planning/publication-transaction-guard";

import { EbayAuthService, createEbayAuthConfig } from "./ebay/ebay-auth.service";
import { EbayApiClient, createEbayApiClient } from "./ebay/ebay-api.client";
import { EbayApiRequestError } from "./ebay/ebay-api-error";
import { EbayInventoryQuantityError, EbayInventoryQuantityPreflightError, discoverEbayInventoryOffers, ebayInventoryMarketplace, publishEbayInventoryQuantity, readEbayInventoryQuantity, type EbayDiscoveredOffer } from "./ebay/ebay-inventory-quantity";
import { EBAY_QUANTITY_BATCH_LIMIT, EbayQuantityUpdateInputError, buildEbayQuantityUpdateRequest, sendEbayQuantityUpdates } from "./ebay/ebay-quantity-update";
import { EbayListingBuilder, createEbayListingBuilder } from "./ebay/ebay-listing-builder";
import { mapCarrierToEbay } from "./ebay/ebay-category-map";
import { EbayMarketplaceListingConnector } from "../listing-connectors/ebay-listing.connector";
import type {
  EbayOrder,
  EbayOrderLineItem,
  EbayNotificationPayload,
  EbayOrderConfirmationData,
  EbayError,
} from "./ebay/ebay-types";

import crypto from "crypto";
import { readExistingEbayListingPhotos } from "./ebay/ebay-listing-photos.reader";
import type { EbayListingPhotoResolver } from "../ebay-listing-photos.service";
import { createEbayMarketplaceRegistrationAdapters } from "./ebay/ebay-marketplace-registration.factory";
import { observeExistingEbayPublication } from "../ebay-existing-listing-identity";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

interface EbayConnectionMetadata {
  clientId?: string;
  clientSecret?: string;
  ruName?: string;
  environment?: "sandbox" | "production";
  siteId?: string;
  merchantLocationKey?: string;
  notificationVerificationToken?: string;
}

const DEFAULT_MARKETPLACE = "EBAY_US";
const ORDER_POLL_PAGE_SIZE = 50;

/**
 * Always surface eBay's numeric errorId alongside the message — sync logs
 * and the orchestrator's permanent-error classifier key off it; a bare
 * message hides which error class actually fired (prod 2026-07-05).
 */
function formatEbayOfferError(
  error: Partial<EbayError> | undefined,
  statusCode: number | undefined,
): string {
  if (!error) return `Status ${statusCode ?? "unknown"}`;
  return error.errorId != null ? `[${error.errorId}] ${error.message ?? "Provider rejected the operation"}`
    : error.message ?? `Status ${statusCode ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// eBay Adapter
// ---------------------------------------------------------------------------

export class EbayAdapter implements IChannelAdapter {
  readonly adapterName = "eBay";
  readonly providerKey = "ebay";
  readonly inventoryPublicationScopeTypes = ["account"] as const;
  readonly shippingCapabilities = Object.freeze({
    acceptsEngineQuotes: false,
    managesOwnRates: true,
    enforcesDestinationEligibility: true,
  });

  private authServices = new Map<string, EbayAuthService>();
  private apiClients = new Map<string, EbayApiClient>();
  private readonly listingBuilder: EbayListingBuilder;
  private readonly listingConnector: EbayMarketplaceListingConnector;

  constructor(private readonly db: DrizzleDb, private readonly photos: EbayListingPhotoResolver,
    private readonly policies: Pick<typeof ebayBusinessPolicies, "resolveProductPolicies"> = ebayBusinessPolicies) {
    this.listingBuilder = createEbayListingBuilder();
    this.listingConnector = new EbayMarketplaceListingConnector({
      delay: (ms) => this.delay(ms),
      inventoryDelayMs: 300,
      offerDelayMs: 300,
    });
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  async pushListings(
    channelId: number,
    listings: ChannelListingPayload[],
  ): Promise<ListingPushResult[]> {
    const client = await this.getApiClient(channelId);
    const metadata = await this.getConnectionMetadata(channelId);
    const results: ListingPushResult[] = [];

    for (const listing of listings) {
      try {
        const result = await this.pushSingleListing(
          client,
          listing,
          channelId,
          metadata,
        );
        results.push(result);
        // Rate limiting between products
        await this.delay(500);
      } catch (err: any) {
        console.error(
          `[EbayAdapter] Failed to push listing for product ${listing.productId}:`,
          err.message,
        );
        results.push({
          productId: listing.productId,
          status: "error",
          error: err.message,
        });
      }
    }

    return results;
  }

  private async pushSingleListing(
    client: EbayApiClient,
    listing: ChannelListingPayload,
    channelId: number,
    metadata: EbayConnectionMetadata,
  ): Promise<ListingPushResult> {
    if (!metadata.merchantLocationKey) {
      return {
        productId: listing.productId,
        status: "error",
        error: "No merchantLocationKey configured. Create a merchant location via eBay Inventory API first.",
      };
    }

    const photoVariants = listing.variants.filter(variant => variant.isListed && variant.sku)
      .map(variant => ({ variantId: variant.variantId, sku: variant.sku! }));
    if (photoVariants.length === 0) return { productId: listing.productId, status: "skipped" };
    const selectedPolicies = await this.policies.resolveProductPolicies({ productId: listing.productId,
      variantIds: photoVariants.map(variant => variant.variantId) });
    // The generic adapter consumes the same validated selections as durable
    // publication. Legacy metadata.businessPolicies is no longer an authority.
    if (selectedPolicies.scope.channelId !== channelId) {
      throw new EbayBusinessPolicyError("EBAY_POLICY_SCOPE_CHANGED", "The resolved business policies belong to another eBay channel.", 409);
    }
    await this.getConnectionMetadata(channelId, selectedPolicies.scope.connectionId);
    const auth = await this.getAuthService(channelId, selectedPolicies.scope.connectionId);
    const account = await auth.getVerifiedProviderAccount(channelId);
    if (auth.getEnvironment() !== selectedPolicies.scope.environment || account?.externalAccountId !== selectedPolicies.scope.accountId) {
      throw new EbayBusinessPolicyError("EBAY_POLICY_SCOPE_CHANGED", "The eBay account changed while preparing listing policies. Refresh the connection before retrying.", 409);
    }
    const listingPolicies = selectedPolicies.byVariantId.values().next().value;
    if (!listingPolicies) throw new EbayBusinessPolicyError("EBAY_POLICY_REQUIRED", "No validated business policies were returned for this listing.", 422);
    const overrides = await this.getChannelOverrides(channelId, listing.productId);
    const config = {
      merchantLocationKey: metadata.merchantLocationKey,
      listingPolicies,
      marketplaceId: selectedPolicies.scope.marketplaceId,
      channelOverrides: overrides || undefined,
    };
    const photoPlan = await this.photos.resolve({
      productId: listing.productId, channelId, variants: photoVariants,
      mode: listing.imageSyncMode === "preserve" ? "preserve" : "catalog",
      readExistingPhotos: () => readExistingEbayListingPhotos(client, {
        groupKey: typeof listing.metadata?.groupKey === "string" ? listing.metadata.groupKey : `ECHELON-P${listing.productId}`,
        variants: photoVariants,
      }),
    });
    const { inventoryItems, offers, itemGroup } = this.listingBuilder.buildListingDraft(listing, config, { photoPlan,
      variantListingPoliciesByVariantId: selectedPolicies.byVariantId, packageRequirementsByVariantId: selectedPolicies.packageRequirementsByVariantId });
    const hasExistingIds = listing.variants.some(
      (v) => v.externalVariantId,
    );
    const pushResult = await this.listingConnector.pushListing({
      client,
      resolvePublishedIdentity: async discovered => {
        const authService = await this.getAuthService(channelId);
        const account = await authService.getVerifiedProviderAccount(channelId);
        if (!account) throw new EbayListingSyncError("EBAY_AUTH_REQUIRED", "A verified eBay account connection is required before updating an existing publication.");
        return observeExistingEbayPublication({
          owner: { kind: "channel", channelId, productId: listing.productId, provider: "ebay", marketplaceId: config.marketplaceId },
          locator: { externalListingId: discovered.listingId, providerPublicationKey: null },
          memberCandidates: offers.map(offer => ({ productVariantId: offer.variantId, sku: offer.sku,
            isActive: true, availableQuantity: offer.payload.availableQuantity })),
        }, createEbayMarketplaceRegistrationAdapters({ authService }).observer, account.externalAccountId);
      },
      draft: {
        productId: listing.productId,
        marketplaceId: config.marketplaceId,
        inventoryItems,
        offers,
        itemGroup,
        publishMode: "publish",
        hasExistingExternalIds: hasExistingIds,
        existingOfferIdsByVariantId: Object.fromEntries(listing.variants.map(variant => [variant.variantId, variant.externalVariantId])),
      },
    });

    return {
      productId: listing.productId,
      status: pushResult.status,
      externalProductId: pushResult.externalProductId,
      externalVariantIds: pushResult.externalVariantIds,
      ...(pushResult.warnings?.length ? { warnings: pushResult.warnings } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async pushInventory(
    channelId: number,
    items: InventoryPushItem[],
    context?: InventoryPublicationContext,
    ownerGuard?: PublicationTransactionGuard,
  ): Promise<InventoryPushResult[]> {
    if (ownerGuard && context) throw new QuantityPublicationAdmissionError("PUBLICATION_OWNER_CONTEXT_INVALID",
      "A legacy work-owner guard cannot replace the canonical outbox owner.");
    if (ownerGuard && items.length !== 1) throw new QuantityPublicationAdmissionError("PUBLICATION_OWNER_SCOPE_INVALID",
      "One saved availability claim can publish only its exact variant.");
    if (context && context.providerScopeType !== "account") {
      return items.map((item) => ({
        variantId: item.variantId,
        pushedQty: 0,
        status: "error" as const,
        error: "eBay canonical inventory publication requires an exact account scope",
        errorCode: "EBAY_INVENTORY_SCOPE_UNSUPPORTED",
        retryable: false,
        effect: "not_sent" as const,
      }));
    }
    // Canonical targets identify the inventory SKU, not an offer ID. Resolve the
    // exact published offer and update both provider limits in one operation.
    // Never enter the legacy item-only PUT / stale-offer recovery below.
    if (context) return this.pushCanonicalInventory(channelId, items, context);
    const publicationItems = items;
    const baseClient = await this.getApiClient(channelId);
    const client = ownerGuard ? baseClient.withPublicationGuard(ownerGuard) : baseClient;
    const results: InventoryPushResult[] = [];

    // Bound input work; the quantity admission owner sends each SKU separately.
    const BATCH_SIZE = EBAY_QUANTITY_BATCH_LIMIT;
    if (publicationItems.some(item => !Number.isSafeInteger(item.allocatedQty) || item.allocatedQty < 0)) {
      throw new EbayQuantityUpdateInputError("An eBay quantity update requires a nonnegative safe integer quantity.");
    }
    const batches: InventoryPushItem[][] = [];

    for (let i = 0; i < publicationItems.length; i += BATCH_SIZE) {
      batches.push(publicationItems.slice(i, i + BATCH_SIZE));
    }
    const offers = publicationItems.filter(item => item.externalVariantId);
    if (new Set(offers.map(item => item.sku)).size !== offers.length
      || new Set(offers.map(item => item.externalVariantId)).size !== offers.length) {
      throw new EbayQuantityUpdateInputError("An eBay quantity batch must contain distinct SKU and offer identities.");
    }
    // Check every bounded segment before the first provider request.
    for (const batch of batches) {
      const updates = batch.filter(item => item.externalVariantId).map(item => ({
        sku: item.sku ?? "",offerId: item.externalVariantId!,quantity: item.allocatedQty,
      }));
      if (updates.length) buildEbayQuantityUpdateRequest(updates);
    }

    for (const batch of batches) {
      // For items with offer IDs, use bulkUpdatePriceQuantity
      const itemsWithOffers = batch.filter((item) => item.externalVariantId);
      const itemsWithoutOffers = batch.filter((item) => !item.externalVariantId);

      // Bulk update for items with existing offers
      if (itemsWithOffers.length > 0) {
        // Do not turn an admission failure or an unknown HTTP outcome into a
        // second write. The publication owner retains the original evidence;
        // a changed offer must be resolved by the identity owner, not by taking
        // the first offer returned for a SKU.
        const updates = itemsWithOffers.map((item) => ({
            sku: item.sku ?? "",
            offerId: item.externalVariantId!,
            quantity: item.allocatedQty,
          }));
        for (const [index,item] of itemsWithOffers.entries()) {
          try {
            // The transport admits one SKU at a time. Preserve earlier results
            // if a later SKU fails, rather than treating the entire batch as unsent.
            const [acknowledgement] = await sendEbayQuantityUpdates(
              request => client.bulkUpdatePriceQuantity(request), [updates[index]!]);
            const statusCode = acknowledgement.statusCode;
            results.push(acknowledgement.confirmed ? {
              variantId: item.variantId,
              pushedQty: item.allocatedQty,
              status: "success",
            } : {
              variantId: item.variantId,
              pushedQty: 0,
              status: "error",
              error: acknowledgement.errors.length === 0 && (statusCode === undefined || statusCode < 300)
                ? "eBay did not confirm the exact SKU/offer quantity operation."
                : formatEbayOfferError(acknowledgement.errors[0], statusCode),
            });
          } catch (error) {
            // The queue's single saved claim owns failure classification and
            // recovery; keep its original error and evidence intact.
            if (ownerGuard || items.length === 1) throw error;
            results.push(legacyInventoryPushFailure(item,error));
          }
        }
      }

      // Items without offer IDs — update inventory directly on the item
      for (const item of itemsWithoutOffers) {
        try {
          if (!item.sku) {
            results.push({
              variantId: item.variantId,
              pushedQty: 0,
              status: "error",
              error: "No SKU or offer ID — run product sync first",
            });
            continue;
          }

          // Update the inventory item's availability
          const existingItem = await client.getInventoryItem(item.sku);
          if (existingItem) {
            existingItem.availability.shipToLocationAvailability.quantity =
              item.allocatedQty;
            await client.createOrReplaceInventoryItem(item.sku, existingItem);
            results.push({
              variantId: item.variantId,
              pushedQty: item.allocatedQty,
              status: "success",
            });
          } else {
            results.push({
              variantId: item.variantId,
              pushedQty: 0,
              status: "error",
              error: `Inventory item not found for SKU ${item.sku}`,
            });
          }
        } catch (error) {
          if (ownerGuard || items.length === 1) throw error;
          results.push(legacyInventoryPushFailure(item,error));
        }
        await this.delay(200);
      }

      // Rate limiting between batches
      await this.delay(500);
    }

    return results;
  }

  async readInventory(
    channelId: number,
    items: InventoryReadItem[],
    context: InventoryPublicationContext,
  ): Promise<InventoryReadResult[]> {
    if (context.providerScopeType !== "account") {
      return items.map((item) => ({
        variantId: item.variantId,
        observedQty: 0,
        status: "error" as const,
        error: "eBay canonical inventory readback requires an exact account scope",
        errorCode: "EBAY_INVENTORY_SCOPE_UNSUPPORTED",
        retryable: false,
      }));
    }
    const publicationItems = items.map((item) => ({
      ...item,
      sku: exactEbayInventoryItemKey(item),
    }));
    const client = await this.getApiClient(
      channelId,
      context.channelConnectionId,
      context.externalScopeId,
    );
    const metadata = await this.getConnectionMetadata(channelId, context.channelConnectionId);
    const results: InventoryReadResult[] = [];
    for (const item of publicationItems) {
      try {
        if (item.providerScopeType !== "account" || item.externalScopeId !== context.externalScopeId) {
          throw new EbayInventoryQuantityError("EBAY_INVENTORY_SCOPE_MISMATCH", "The item does not belong to the selected eBay account scope.");
        }
        const observation = await readEbayInventoryQuantity(client, item.sku, ebayInventoryMarketplace(metadata.siteId));
        results.push({ variantId: item.variantId, observedQty: observation.observedQuantity,
          quantityConsistent: observation.quantityConsistent, status: "success", providerResponse: observation });
      } catch (error) {
        results.push({
          variantId: item.variantId,
          observedQty: 0,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof EbayInventoryQuantityError ? { errorCode: error.code, retryable: error.retryable } : {}),
        });
      }
    }
    return results;
  }

  /**
   * Channels PR4: every offer eBay holds for one SKU on the connection's marketplace, read with the exact verified
   * publication account (the same client and discovery the quantity write uses). Read-only; the stock-link adapter
   * (ebay-stock-link.adapter.ts) classifies its failures.
   */
  async discoverStockLinkOffers(channelId: number, channelConnectionId: number, externalScopeId: string, sku: string):
    Promise<{ marketplaceId: string; offers: EbayDiscoveredOffer[] }> {
    const client = await this.getApiClient(channelId, channelConnectionId, externalScopeId);
    const metadata = await this.getConnectionMetadata(channelId, channelConnectionId);
    const marketplaceId = ebayInventoryMarketplace(metadata.siteId);
    // eBay answers "this SKU has no offer" with a 404 (25713) on the first page: an empty, complete answer.
    const pages = { getInventoryOffersPage: async (pageSku: string, pageMarketplace: string, offset: number, limit: number) => {
      try { return await client.getInventoryOffersPage(pageSku, pageMarketplace, offset, limit); }
      catch (error) {
        if (offset === 0 && error instanceof EbayApiRequestError && error.statusCode === 404) return { total: 0, offers: [] };
        throw error;
      }
    } };
    return { marketplaceId, offers: await discoverEbayInventoryOffers(pages, sku, marketplaceId) };
  }

  private async pushCanonicalInventory(
    channelId: number, items: InventoryPushItem[], context: InventoryPublicationContext,
  ): Promise<InventoryPushResult[]> {
    let client: EbayApiClient;
    let marketplace: string;
    try {
      client = await this.getApiClient(channelId, context.channelConnectionId, context.externalScopeId);
      const metadata = await this.getConnectionMetadata(channelId, context.channelConnectionId);
      marketplace = ebayInventoryMarketplace(metadata.siteId);
    } catch (error) { return items.map(item => canonicalEbayInventoryFailure(item, error, true)); }
    const results: InventoryPushResult[] = [];
    for (const item of items) {
      let sku: string;
      try { sku = exactEbayInventoryItemKey(item); }
      catch (error) { results.push(canonicalEbayInventoryFailure(item, error, true)); continue; }
      try {
        const providerResponse = await publishEbayInventoryQuantity(client, sku, marketplace, item.allocatedQty);
        results.push({ variantId: item.variantId, pushedQty: item.allocatedQty, status: "success", providerResponse });
      } catch (error) {
        results.push(canonicalEbayInventoryFailure(item, error, error instanceof EbayInventoryQuantityPreflightError));
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  async pushPricing(
    channelId: number,
    items: PricingPushItem[],
  ): Promise<PricingPushResult[]> {
    const client = await this.getApiClient(channelId);
    const results: PricingPushResult[] = [];

    // Use bulkUpdatePriceQuantity for efficiency
    const BATCH_SIZE = 25;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const validItems = batch.filter((item) => item.externalVariantId);

      if (validItems.length > 0) {
        try {
          const bulkRequest = {
            requests: validItems.map((item) => ({
              sku: item.sku || String(item.variantId),
              offers: [
                {
                  offerId: item.externalVariantId!,
                  price: {
                    value: (item.priceCents / 100).toFixed(2),
                    currency: item.currency || "USD",
                  },
                },
              ],
            })),
          };

          const response = await client.bulkUpdatePriceQuantity(bulkRequest);

          for (const item of validItems) {
            const resp = response?.responses?.find((r) =>
              r.offerId === item.externalVariantId ||
              r.offers?.some((offer) => offer.offerId === item.externalVariantId),
            );
            const offerResp = resp?.offers?.find((offer) => offer.offerId === item.externalVariantId);
            const statusCode = offerResp?.statusCode ?? resp?.statusCode;
            if (statusCode && statusCode >= 200 && statusCode < 300) {
              results.push({ variantId: item.variantId, status: "success" });
            } else {
              results.push({
                variantId: item.variantId,
                status: "error",
                error: formatEbayOfferError(offerResp?.errors?.[0] ?? resp?.errors?.[0], statusCode),
              });
            }
          }
        } catch (err: any) {
          // Individual fallback
          for (const item of validItems) {
            results.push({
              variantId: item.variantId,
              status: "error",
              error: err.message,
            });
          }
        }
      }

      // Items without offer IDs
      const invalidItems = batch.filter((item) => !item.externalVariantId);
      for (const item of invalidItems) {
        results.push({
          variantId: item.variantId,
          status: "error",
          error: "No externalVariantId (offerId) — run product sync first",
        });
      }

      await this.delay(300);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Pull orders from eBay via polling (Fulfillment API).
   * Used as 5-minute safety net alongside push notifications.
   */
  async pullOrders(
    channelId: number,
    since: Date,
  ): Promise<ChannelOrder[]> {
    const client = await this.getApiClient(channelId);
    const orders: ChannelOrder[] = [];

    // eBay date format for filters: ISO 8601
    const sinceStr = since.toISOString();
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const filter = `creationdate:[${sinceStr}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`;

      const response = await client.getOrders({
        filter,
        limit: ORDER_POLL_PAGE_SIZE,
        offset,
      });

      if (response.orders && response.orders.length > 0) {
        for (const order of response.orders) {
          orders.push(this.mapEbayOrder(order, channelId));
        }

        offset += response.orders.length;
        hasMore =
          response.orders.length === ORDER_POLL_PAGE_SIZE &&
          offset < response.total;
      } else {
        hasMore = false;
      }

      await this.delay(200);
    }

    console.log(
      `[EbayAdapter] Polled ${orders.length} orders since ${sinceStr} for channel ${channelId}`,
    );

    return orders;
  }

  /**
   * Receive and parse an order from an eBay push notification.
   * Verifies the notification signature and fetches the full order.
   */
  async receiveOrder(
    channelId: number,
    rawPayload: unknown,
    headers: Record<string, string>,
  ): Promise<ChannelOrder | null> {
    const metadata = await this.getConnectionMetadata(channelId);

    // Parse the notification
    const payload =
      typeof rawPayload === "string"
        ? (JSON.parse(rawPayload) as EbayNotificationPayload)
        : (rawPayload as EbayNotificationPayload);

    // Verify it's an order notification
    if (payload?.metadata?.topic !== "MARKETPLACE.ORDER.CREATED" &&
        payload?.metadata?.topic !== "ORDER_CONFIRMATION") {
      console.log(
        `[EbayAdapter] Ignoring non-order notification: ${payload?.metadata?.topic}`,
      );
      return null;
    }

    // Extract order ID from notification
    const orderData = (payload.notification?.data as unknown) as EbayOrderConfirmationData;
    if (!orderData?.orderId) {
      console.warn(
        `[EbayAdapter] Order notification missing orderId`,
      );
      return null;
    }

    // Fetch full order details from Fulfillment API
    const client = await this.getApiClient(channelId);
    const fullOrder = await client.getOrder(orderData.orderId);

    if (!fullOrder) {
      console.warn(
        `[EbayAdapter] Could not fetch order ${orderData.orderId}`,
      );
      return null;
    }

    return this.mapEbayOrder(fullOrder, channelId);
  }

  /**
   * Map an eBay order to our canonical ChannelOrder format.
   */
  private mapEbayOrder(ebayOrder: EbayOrder, channelId: number): ChannelOrder {
    const lineItems: ChannelOrderLineItem[] = (
      ebayOrder.lineItems || []
    ).map((item) => this.mapEbayLineItem(item));

    // Extract shipping address
    const fulfillmentInstruction = ebayOrder.fulfillmentStartInstructions?.[0];
    const shipTo = fulfillmentInstruction?.shippingStep?.shipTo;
    const contactAddress = shipTo?.contactAddress;

    const shippingAddress = shipTo
      ? {
          name: shipTo.fullName || null,
          address1: contactAddress?.addressLine1 || null,
          address2: contactAddress?.addressLine2 || null,
          city: contactAddress?.city || null,
          province: contactAddress?.stateOrProvince || null,
          zip: contactAddress?.postalCode || null,
          country: contactAddress?.countryCode || null,
          phone: shipTo.primaryPhone?.phoneNumber || null,
        }
      : null;

    // Calculate totals from pricing summary
    const pricing = ebayOrder.pricingSummary || {};
    const subtotalCents = this.parseAmountCents(pricing.priceSubtotal);
    const shippingCents = this.parseAmountCents(pricing.deliveryCost);
    const taxCents = this.parseAmountCents(pricing.tax);
    const totalCents = this.parseAmountCents(pricing.total);
    const discountCents = this.parseAmountCents(pricing.priceDiscount);

    // Map payment status
    const financialStatus = this.mapPaymentStatus(
      ebayOrder.orderPaymentStatus,
    );

    // Map fulfillment status
    const fulfillmentStatus = this.mapFulfillmentStatus(
      ebayOrder.orderFulfillmentStatus,
    );

    return {
      externalOrderId: ebayOrder.orderId,
      channelId,
      source: "ebay",
      customerEmail: shipTo?.email || null,
      customerName: shipTo?.fullName || ebayOrder.buyer?.username || null,
      shippingAddress,
      lineItems,
      subtotalCents,
      taxCents,
      shippingCents,
      discountCents,
      totalCents,
      currency: pricing.total?.currency || "USD",
      financialStatus,
      fulfillmentStatus,
      notes: null,
      tags: null,
      orderDate: new Date(ebayOrder.creationDate),
      rawPayload: ebayOrder,
    };
  }

  private mapEbayLineItem(item: EbayOrderLineItem): ChannelOrderLineItem {
    const priceCents = this.parseAmountCents(item.lineItemCost);
    const taxCents = this.parseAmountCents(item.tax?.amount);
    const shippingCostCents = this.parseAmountCents(
      item.deliveryCost?.shippingCost,
    );
    const discountCents = item.discountedLineItemCost
      ? priceCents - this.parseAmountCents(item.discountedLineItemCost)
      : 0;
    const totalCents = this.parseAmountCents(item.total);

    return {
      externalLineItemId: item.lineItemId,
      sku: item.sku || "",
      title: item.title || "",
      quantity: item.quantity,
      priceCents,
      discountCents: Math.max(0, discountCents),
      taxCents,
      totalCents,
    };
  }

  // -------------------------------------------------------------------------
  // Fulfillment
  // -------------------------------------------------------------------------

  async pushFulfillment(
    channelId: number,
    fulfillments: FulfillmentPayload[],
  ): Promise<FulfillmentPushResult[]> {
    const client = await this.getApiClient(channelId);
    const results: FulfillmentPushResult[] = [];

    for (const fulfillment of fulfillments) {
      try {
        if (!fulfillment.trackingNumber) {
          results.push({
            externalOrderId: fulfillment.externalOrderId,
            status: "error",
            error: "eBay requires a tracking number for fulfillment",
          });
          continue;
        }

        const response = await client.createShippingFulfillment(
          fulfillment.externalOrderId,
          {
            lineItems: fulfillment.lineItems.map((li) => ({
              lineItemId: li.externalLineItemId,
              quantity: li.quantity,
            })),
            shippedDate: new Date().toISOString(),
            shippingCarrierCode: mapCarrierToEbay(fulfillment.carrier),
            trackingNumber: fulfillment.trackingNumber,
          },
        );

        results.push({
          externalOrderId: fulfillment.externalOrderId,
          externalFulfillmentId: response?.fulfillmentId,
          status: "success",
        });
      } catch (err: any) {
        results.push({
          externalOrderId: fulfillment.externalOrderId,
          status: "error",
          error: err.message,
        });
      }

      await this.delay(300);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Cancellations (stub)
  // -------------------------------------------------------------------------

  async pushCancellation(
    _channelId: number,
    cancellations: CancellationPayload[],
  ): Promise<CancellationPushResult[]> {
    return cancellations.map((c) => ({
      externalOrderId: c.externalOrderId,
      status: "not_supported" as const,
      error: "eBay order cancellation push not yet implemented. Use eBay Seller Hub for now.",
    }));
  }

  // -------------------------------------------------------------------------
  // Helper Methods
  // -------------------------------------------------------------------------

  private async getApiClient(
    channelId: number,
    channelConnectionId?: number,
    exactExternalAccountId?: string,
  ): Promise<EbayApiClient> {
    if (exactExternalAccountId !== undefined) {
      await this.assertExactPublicationAccount(
        channelId,
        channelConnectionId,
        exactExternalAccountId,
      );
    }
    const cacheKey = `${channelId}:${channelConnectionId ?? "default"}`;
    if (this.apiClients.has(cacheKey)) {
      return this.apiClients.get(cacheKey)!;
    }

    const authService = await this.getAuthService(channelId, channelConnectionId);
    const metadata = await this.getConnectionMetadata(channelId, channelConnectionId);
    const environment = metadata.environment || "production";

    const client = createEbayApiClient(authService, channelId, environment);
    this.apiClients.set(cacheKey, client);
    return client;
  }

  private async assertExactPublicationAccount(
    channelId: number,
    channelConnectionId: number | undefined,
    exactExternalAccountId: string,
  ): Promise<void> {
    const normalizedAccountId = exactExternalAccountId.trim();
    if (!normalizedAccountId || channelConnectionId === undefined) {
      throw new InventoryPublicationConfigurationError(
        "EBAY_PUBLICATION_ACCOUNT_SCOPE_INVALID",
        "eBay canonical inventory publication requires an exact connection and provider account.",
      );
    }
    await this.getConnectionMetadata(channelId, channelConnectionId);
    const account = await (await this.getAuthService(
      channelId,
      channelConnectionId,
    )).getVerifiedProviderAccount(channelId);
    if (!account) {
      throw new InventoryPublicationConfigurationError(
        "EBAY_PROVIDER_ACCOUNT_IDENTITY_UNVERIFIED",
        "The eBay OAuth credential has no persisted provider-verified account identity.",
      );
    }
    if (account.externalAccountId !== normalizedAccountId) {
      throw new InventoryPublicationConfigurationError(
        "EBAY_PROVIDER_ACCOUNT_IDENTITY_MISMATCH",
        "The publication target account does not match the provider-verified eBay OAuth account.",
      );
    }
  }

  private async getAuthService(
    channelId: number,
    channelConnectionId?: number,
  ): Promise<EbayAuthService> {
    const cacheKey = `${channelId}:${channelConnectionId ?? "default"}`;
    const cached = this.authServices.get(cacheKey);
    if (cached) return cached;

    // Try env vars first, fall back to connection metadata
    try {
      const config = createEbayAuthConfig();
      const service = new EbayAuthService(this.db, config);
      this.authServices.set(cacheKey, service);
      return service;
    } catch {
      // Fall back to connection metadata
      const metadata = await this.getConnectionMetadata(channelId, channelConnectionId);
      if (!metadata.clientId || !metadata.clientSecret || !metadata.ruName) {
        throw new Error(
          "eBay OAuth config not found. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME " +
          "env vars or store in channel connection metadata.",
        );
      }
      const service = new EbayAuthService(this.db, {
        clientId: metadata.clientId,
        clientSecret: metadata.clientSecret,
        ruName: metadata.ruName,
        environment: metadata.environment || "production",
      });
      this.authServices.set(cacheKey, service);
      return service;
    }
  }

  private async getConnectionMetadata(
    channelId: number,
    channelConnectionId?: number,
  ): Promise<EbayConnectionMetadata> {
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(channelConnectionId === undefined
        ? eq(channelConnections.channelId, channelId)
        : and(
          eq(channelConnections.id, channelConnectionId),
          eq(channelConnections.channelId, channelId),
        ))
      .limit(1);

    if (!conn) {
      throw new Error(
        `No channel connection found for channel ${channelId}`
          + (channelConnectionId === undefined ? "" : ` connection ${channelConnectionId}`),
      );
    }

    if (channelConnectionId !== undefined) {
      const connections = await this.db
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(eq(channelConnections.channelId, channelId))
        .limit(2);
      if (connections.length !== 1 || connections[0]?.id !== channelConnectionId) {
        throw new InventoryPublicationConfigurationError(
          "EBAY_CONNECTION_SCOPED_AUTH_UNAVAILABLE",
          `eBay canonical inventory requires exactly one connection for channel ${channelId}; `
            + "OAuth tokens are currently channel-scoped.",
        );
      }
    }

    return (conn.metadata as EbayConnectionMetadata) || {};
  }

  private async getChannelOverrides(
    channelId: number,
    productId: number,
  ): Promise<{
    itemSpecifics?: Record<string, string[]> | null;
    marketplaceCategoryId?: string | null;
    listingFormat?: string | null;
    conditionId?: number | null;
    titleOverride?: string | null;
    descriptionOverride?: string | null;
  } | null> {
    try {
      const [override] = await this.db
        .select()
        .from(channelProductOverrides)
        .where(
          and(
            eq(channelProductOverrides.channelId, channelId),
            eq(channelProductOverrides.productId, productId),
          ),
        )
        .limit(1);

      if (!override) return null;

      return {
        itemSpecifics: override.itemSpecifics as Record<string, string[]> | null,
        marketplaceCategoryId: override.marketplaceCategoryId,
        listingFormat: override.listingFormat,
        conditionId: override.conditionId,
        titleOverride: override.titleOverride,
        descriptionOverride: override.descriptionOverride,
      };
    } catch {
      return null;
    }
  }

  private parseAmountCents(
    amount?: { value: string; currency: string } | null,
  ): number {
    if (!amount?.value) return 0;
    return parseDecimalCents(amount.value, "provider amount");
  }

  private mapPaymentStatus(
    status?: string,
  ): string | null {
    if (!status) return null;
    const map: Record<string, string> = {
      PAID: "paid",
      PENDING: "pending",
      FAILED: "failed",
      FULLY_REFUNDED: "refunded",
      PARTIALLY_REFUNDED: "partially_refunded",
    };
    return map[status] || status.toLowerCase();
  }

  private mapFulfillmentStatus(
    status?: string,
  ): string | null {
    if (!status) return null;
    const map: Record<string, string> = {
      NOT_STARTED: "unfulfilled",
      IN_PROGRESS: "partial",
      FULFILLED: "fulfilled",
    };
    return map[status] || status.toLowerCase();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function canonicalEbayInventoryFailure(item: InventoryPushItem, error: unknown, preflight: boolean): InventoryPushResult {
  return { variantId: item.variantId, pushedQty: 0, status: "error",
    error: error instanceof Error ? error.message : String(error),
    ...(preflight ? { effect: "not_sent" as const } : {}),
    ...(error instanceof EbayInventoryQuantityError ? { errorCode: error.code, retryable: error.retryable }
      : error instanceof InventoryPublicationConfigurationError ? { errorCode: error.code, retryable: false }
      : preflight ? { errorCode: "EBAY_INVENTORY_PREFLIGHT_FAILED", retryable: true } : {}),
  };
}

function legacyInventoryPushFailure(item: InventoryPushItem, error: unknown): InventoryPushResult {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const retryable = error instanceof Error && "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : undefined;
  return { variantId: item.variantId,pushedQty: 0,status: "error",error: error instanceof Error ? error.message : String(error),
    ...(code ? { errorCode: code } : {}),...(retryable === undefined ? {} : { retryable }) };
}

function exactEbayInventoryItemKey(
  item: Pick<InventoryPushItem, "externalInventoryItemId" | "sku">,
): string {
  const inventoryItemId = item.externalInventoryItemId?.trim();
  if (!inventoryItemId) {
    throw new InventoryPublicationConfigurationError(
      "EBAY_INVENTORY_ID_REQUIRED",
      "eBay canonical inventory publication requires the exact provider inventory-item ID.",
    );
  }
  const externalSku = item.sku?.trim() || null;
  if (externalSku !== null && externalSku !== inventoryItemId) {
    throw new InventoryPublicationConfigurationError(
      "EBAY_INVENTORY_IDENTITY_MISMATCH",
      "The eBay inventory-item ID must equal the external SKU recorded by eBay registration.",
    );
  }
  return inventoryItemId;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEbayAdapter(db: any, photos: EbayListingPhotoResolver): EbayAdapter {
  return new EbayAdapter(db, photos);
}
