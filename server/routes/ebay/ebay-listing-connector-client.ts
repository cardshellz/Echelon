import { z } from "zod";

import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorClient,
  type EbayObservedOffer,
} from "../../modules/channels/listing-connectors/ebay-listing.connector";
import type {
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../../modules/channels/adapters/ebay/ebay-types";
import { ebayApiRequest, ebayApiRequestWithRateNotify } from "./ebay-utils";

const ebayListingConnector = new EbayMarketplaceListingConnector();

const ebayObservedOfferSchema = z.object({
  offerId: z.string().trim().min(1).max(255),
  status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
  availableQuantity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  listingId: z.string().trim().min(1).max(255).optional(),
  listing: z.object({
    listingId: z.string().trim().min(1).max(255),
  }).passthrough().optional(),
}).passthrough();

const ebayOffersResponseSchema = z.object({
  offers: z.array(ebayObservedOfferSchema).max(10_000).default([]),
}).passthrough();

export function normalizeEbayObservedOffers(response: unknown): EbayObservedOffer[] {
  return ebayOffersResponseSchema.parse(response).offers.map((offer) => {
    const listingId = offer.listingId ?? offer.listing?.listingId;
    return {
      ...offer,
      offerId: offer.offerId,
      status: offer.status,
      ...(listingId === undefined ? {} : { listingId }),
    } as unknown as EbayObservedOffer;
  });
}

interface EbayRouteClientInput {
  accessToken: string;
  onRateLimit?: (waitSeconds: number) => void;
}

export interface EbayRouteListingLifecycleClient extends EbayListingConnectorClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<EbayInventoryItemGroup | null>;
  withdrawOffer(offerId: string): Promise<void>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
  bulkUpdatePriceQuantity(request: unknown): Promise<void>;
  deleteOffer(offerId: string): Promise<void>;
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
  deleteInventoryItem(sku: string): Promise<void>;
}

function createEbayRouteRequest(input: EbayRouteClientInput) {
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    if (input.onRateLimit) {
      return (await ebayApiRequestWithRateNotify(
        method,
        path,
        input.accessToken,
        body,
        input.onRateLimit,
      )) as T;
    }
    return (await ebayApiRequest(method, path, input.accessToken, body)) as T;
  };
}

export function createEbayRouteListingClient(
  input: EbayRouteClientInput,
): EbayListingConnectorClient {
  const request = createEbayRouteRequest(input);
  return {
    getInventoryItem: async (sku) => {
      try {
        return await request<EbayInventoryItem>(
          "GET",
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        );
      } catch (error: any) {
        const message = String(error?.message ?? "");
        if (message.includes("404") || message.includes("25710")) {
          return null;
        }
        throw error;
      }
    },
    createOrReplaceInventoryItem: async (sku, item) => {
      await request(
        "PUT",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        item,
      );
    },
    getOffers: async (sku, marketplaceId) => {
      try {
        const response = await request<unknown>(
          "GET",
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`,
        );
        return { offers: normalizeEbayObservedOffers(response) };
      } catch (error: any) {
        if (String(error?.message ?? "").includes("404")) {
          return { offers: [] };
        }
        throw error;
      }
    },
    createOffer: async (offer) => {
      const response = await request<{ offerId?: string }>(
        "POST",
        "/sell/inventory/v1/offer",
        offer,
      );
      if (!response.offerId) {
        throw new Error("eBay create offer did not return an offer id.");
      }
      return response.offerId;
    },
    updateOffer: async (offerId, offer) => {
      await request(
        "PUT",
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        offer,
      );
    },
    createOrReplaceInventoryItemGroup: async (groupKey, group) => {
      await request(
        "PUT",
        `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
        { ...group, inventoryItemGroupKey: groupKey },
      );
    },
    publishOffer: async (offerId) => {
      return await request<{ listingId?: string }>(
        "POST",
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      );
    },
    publishOfferByInventoryItemGroup: async (
      inventoryItemGroupKey,
      marketplaceId,
    ) => {
      return await request<{ listingId?: string }>(
        "POST",
        "/sell/inventory/v1/offer/publish_by_inventory_item_group",
        { inventoryItemGroupKey, marketplaceId },
      );
    },
  };
}

export function createEbayRouteListingLifecycleClient(
  input: EbayRouteClientInput,
): EbayRouteListingLifecycleClient {
  const request = createEbayRouteRequest(input);
  return {
    ...createEbayRouteListingClient(input),
    getInventoryItemGroup: async (groupKey) => {
      try {
        return await request<EbayInventoryItemGroup>(
          "GET",
          `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("404") || message.includes("25710")) return null;
        throw error;
      }
    },
    withdrawOffer: async (offerId) => {
      await request(
        "POST",
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
      );
    },
    withdrawOfferByInventoryItemGroup: async (groupKey, marketplaceId) => {
      await request(
        "POST",
        "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
        { inventoryItemGroupKey: groupKey, marketplaceId },
      );
    },
    bulkUpdatePriceQuantity: async (body) => {
      await request(
        "POST",
        "/sell/inventory/v1/bulk_update_price_quantity",
        body,
      );
    },
    deleteOffer: async (offerId) => {
      await request(
        "DELETE",
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      );
    },
    deleteInventoryItemGroup: async (groupKey) => {
      await request(
        "DELETE",
        `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
      );
    },
    deleteInventoryItem: async (sku) => {
      await request(
        "DELETE",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      );
    },
  };
}

export async function getExistingEbayInventoryImageUrls(input: {
  accessToken: string;
  sku: string;
}): Promise<string[]> {
  return await ebayListingConnector.getExistingInventoryImageUrls({
    client: createEbayRouteListingClient({ accessToken: input.accessToken }),
    sku: input.sku,
  });
}
