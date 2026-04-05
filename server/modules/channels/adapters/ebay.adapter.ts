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
  PricingPushItem,
  PricingPushResult,
  ChannelOrder,
  ChannelOrderLineItem,
  FulfillmentPayload,
  FulfillmentPushResult,
  CancellationPayload,
  CancellationPushResult,
} from "../channel-adapter.interface";

import { EbayAuthService, createEbayAuthConfig } from "./ebay/ebay-auth.service";
import { EbayApiClient, createEbayApiClient } from "./ebay/ebay-api.client";
import { EbayListingBuilder, createEbayListingBuilder } from "./ebay/ebay-listing-builder";
import { mapCarrierToEbay } from "./ebay/ebay-category-map";
import type {
  EbayOrder,
  EbayOrderLineItem,
  EbayNotificationPayload,
  EbayOrderConfirmationData,
} from "./ebay/ebay-types";

import crypto from "crypto";

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
  businessPolicies?: {
    paymentPolicyId: string;
    returnPolicyId: string;
    fulfillmentPolicyId: string;
  };
  merchantLocationKey?: string;
  notificationVerificationToken?: string;
}

const DEFAULT_MARKETPLACE = "EBAY_US";
const ORDER_POLL_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// eBay Adapter
// ---------------------------------------------------------------------------

export class EbayAdapter implements IChannelAdapter {
  readonly adapterName = "eBay";
  readonly providerKey = "ebay";

  private authService: EbayAuthService | null = null;
  private apiClients = new Map<number, EbayApiClient>();
  private readonly listingBuilder: EbayListingBuilder;

  constructor(private readonly db: DrizzleDb) {
    this.listingBuilder = createEbayListingBuilder();
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
    if (!metadata.businessPolicies) {
      return {
        productId: listing.productId,
        status: "error",
        error: "No eBay business policies configured. Set paymentPolicyId, returnPolicyId, and fulfillmentPolicyId in channel connection metadata.",
      };
    }

    if (!metadata.merchantLocationKey) {
      return {
        productId: listing.productId,
        status: "error",
        error: "No merchantLocationKey configured. Create a merchant location via eBay Inventory API first.",
      };
    }

    // Load channel-level overrides
    const overrides = await this.getChannelOverrides(channelId, listing.productId);

    const config = {
      merchantLocationKey: metadata.merchantLocationKey,
      listingPolicies: {
        paymentPolicyId: metadata.businessPolicies.paymentPolicyId,
        returnPolicyId: metadata.businessPolicies.returnPolicyId,
        fulfillmentPolicyId: metadata.businessPolicies.fulfillmentPolicyId,
      },
      marketplaceId: metadata.siteId || DEFAULT_MARKETPLACE,
      channelOverrides: overrides || undefined,
    };

    // Step 1: Create/update inventory items (one per variant SKU)
    const inventoryItems = this.listingBuilder.buildInventoryItems(listing, config);
    for (const item of inventoryItems) {
      await client.createOrReplaceInventoryItem(item.sku, item.payload);
      await this.delay(300);
    }

    // Step 2: Create/update offers (one per variant)
    const offers = this.listingBuilder.buildOffers(listing, config);
    const variantIdMap: Record<number, string> = {};

    for (const offer of offers) {
      // Check if offer already exists
      const existingOffers = await client.getOffers(offer.sku, config.marketplaceId);
      let offerId: string;

      if (existingOffers.offers && existingOffers.offers.length > 0) {
        // Update existing offer
        offerId = existingOffers.offers[0].offerId;
        offer.payload.offerId = offerId;
        await client.updateOffer(offerId, offer.payload);
      } else {
        // Create new offer
        offerId = await client.createOffer(offer.payload);
      }

      variantIdMap[offer.variantId] = offerId;
      await this.delay(300);
    }

    // Step 3: Handle multi-variation vs single-variation listing
    const itemGroup = this.listingBuilder.buildItemGroup(listing, config);
    let externalProductId: string | undefined;

    if (itemGroup) {
      // Multi-variation: create group and publish
      await client.createOrReplaceInventoryItemGroup(
        itemGroup.groupKey,
        itemGroup.payload,
      );
      const publishResult = await client.publishOfferByInventoryItemGroup(
        itemGroup.groupKey,
        config.marketplaceId,
      );
      externalProductId = publishResult?.listingId;
    } else if (offers.length === 1) {
      // Single-variation: publish the single offer
      const offerId = Object.values(variantIdMap)[0];
      if (offerId) {
        const publishResult = await client.publishOffer(offerId);
        externalProductId = publishResult?.listingId;
      }
    }

    // Determine if this was a create or update
    const hasExistingIds = listing.variants.some(
      (v) => v.externalVariantId,
    );

    return {
      productId: listing.productId,
      status: hasExistingIds ? "updated" : "created",
      externalProductId,
      externalVariantIds: variantIdMap,
    };
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async pushInventory(
    channelId: number,
    items: InventoryPushItem[],
  ): Promise<InventoryPushResult[]> {
    const client = await this.getApiClient(channelId);
    const results: InventoryPushResult[] = [];

    // eBay supports bulk update — batch up to 25 items per call
    const BATCH_SIZE = 25;
    const batches: InventoryPushItem[][] = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push(items.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      // For items with offer IDs, use bulkUpdatePriceQuantity
      const itemsWithOffers = batch.filter((item) => item.externalVariantId);
      const itemsWithoutOffers = batch.filter((item) => !item.externalVariantId);

      // Bulk update for items with existing offers
      if (itemsWithOffers.length > 0) {
        try {
          const bulkRequest = {
            requests: itemsWithOffers.map((item) => ({
              offerId: item.externalVariantId!,
              availableQuantity: item.allocatedQty,
              price: {
                value: "0", // Will be ignored if not changing price
                currency: "USD",
              },
            })),
          };

          const response = await client.bulkUpdatePriceQuantity(bulkRequest);

          for (const item of itemsWithOffers) {
            const resp = response?.responses?.find(
              (r) => r.offerId === item.externalVariantId,
            );
            if (resp && resp.statusCode >= 200 && resp.statusCode < 300) {
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
                error: resp?.errors?.[0]?.message || `Status ${resp?.statusCode}`,
              });
            }
          }
        } catch (err: any) {
          // If bulk fails, try individual updates
          for (const item of itemsWithOffers) {
            try {
              const existingOffers = await client.getOffers(item.sku || "");
              if (existingOffers.offers?.[0]) {
                const offer = existingOffers.offers[0];
                offer.availableQuantity = item.allocatedQty;
                await client.updateOffer(offer.offerId, offer as any);
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
                  error: "No existing offer found for SKU",
                });
              }
            } catch (innerErr: any) {
              results.push({
                variantId: item.variantId,
                pushedQty: 0,
                status: "error",
                error: innerErr.message,
              });
            }
            await this.delay(200);
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
        } catch (err: any) {
          results.push({
            variantId: item.variantId,
            pushedQty: 0,
            status: "error",
            error: err.message,
          });
        }
        await this.delay(200);
      }

      // Rate limiting between batches
      await this.delay(500);
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
              offerId: item.externalVariantId!,
              availableQuantity: -1, // -1 = don't change quantity
              price: {
                value: (item.priceCents / 100).toFixed(2),
                currency: item.currency || "USD",
              },
            })),
          };

          const response = await client.bulkUpdatePriceQuantity(bulkRequest);

          for (const item of validItems) {
            const resp = response?.responses?.find(
              (r) => r.offerId === item.externalVariantId,
            );
            if (resp && resp.statusCode >= 200 && resp.statusCode < 300) {
              results.push({ variantId: item.variantId, status: "success" });
            } else {
              results.push({
                variantId: item.variantId,
                status: "error",
                error: resp?.errors?.[0]?.message || `Status ${resp?.statusCode}`,
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

  private async getApiClient(channelId: number): Promise<EbayApiClient> {
    if (this.apiClients.has(channelId)) {
      return this.apiClients.get(channelId)!;
    }

    const authService = await this.getAuthService(channelId);
    const metadata = await this.getConnectionMetadata(channelId);
    const environment = metadata.environment || "production";

    const client = createEbayApiClient(authService, channelId, environment);
    this.apiClients.set(channelId, client);
    return client;
  }

  private async getAuthService(channelId: number): Promise<EbayAuthService> {
    if (this.authService) return this.authService;

    // Try env vars first, fall back to connection metadata
    try {
      const config = createEbayAuthConfig();
      this.authService = new EbayAuthService(this.db, config);
      return this.authService;
    } catch {
      // Fall back to connection metadata
      const metadata = await this.getConnectionMetadata(channelId);
      if (!metadata.clientId || !metadata.clientSecret || !metadata.ruName) {
        throw new Error(
          "eBay OAuth config not found. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME " +
          "env vars or store in channel connection metadata.",
        );
      }
      this.authService = new EbayAuthService(this.db, {
        clientId: metadata.clientId,
        clientSecret: metadata.clientSecret,
        ruName: metadata.ruName,
        environment: metadata.environment || "production",
      });
      return this.authService;
    }
  }

  private async getConnectionMetadata(
    channelId: number,
  ): Promise<EbayConnectionMetadata> {
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn) {
      throw new Error(
        `No channel connection found for channel ${channelId}`,
      );
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
    return Math.round(parseFloat(amount.value) * 100);
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEbayAdapter(db: any): EbayAdapter {
  return new EbayAdapter(db);
}
