import { z } from "zod";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";

import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorClient,
  type EbayObservedOffer,
} from "../listing-connectors/ebay-listing.connector";
import type {
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../adapters/ebay/ebay-types";
import {
  ebayApiRequest,
  ebayApiRequestWithRateNotify,
  getAuthService,
  EBAY_CHANNEL_ID,
} from "./ebay-api-runtime";
import {
  ebayQuantityMutationIdentity,
  executeAdmittedEbayQuantityRequest,
  type EbayQuantityHttpRequest,
  type EbayQuantityRequestAdmission,
} from "../quantity-publication-request";

import { isMissingEbayInventoryResource } from "../adapters/ebay/ebay-api-error";
import { readExistingEbayListingPhotos } from "../adapters/ebay/ebay-listing-photos.reader";
import type {
  EbayListingPhotoPlan,
  EbayPhotoVariant,
} from "../ebay-listing-photos.domain";

const ebayListingConnector = new EbayMarketplaceListingConnector();

function normalizePublishedListingResponse(response: unknown): { listingId: string } {
  const parsed = z.object({ listingId: z.string().trim().min(1).max(255) }).safeParse(response);
  if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
    "eBay publish did not return a valid listing id. Publication may have completed; review the existing listing before another publication attempt.");
  return parsed.data;
}

const ebayObservedOfferSchema = z
  .object({
    sku: z.string().min(1).max(100).refine(value => value.trim().length > 0),
    offerId: z.string().trim().min(1).max(255),
    status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
    availableQuantity: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    listingId: z.string().trim().min(1).max(255).optional(),
    listing: z
      .object({
        listingId: z.string().trim().min(1).max(255),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((offer, context) => {
    if (offer.listingId && offer.listing?.listingId && offer.listingId !== offer.listing.listingId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["listingId"], message: "Conflicting listing identifiers." });
    }
  });

const ebayOffersResponseSchema = z
  .object({
    offers: z.array(ebayObservedOfferSchema).max(10_000),
  })
  .passthrough();

const ebayObservedInventoryItemGroupSchema = z.object({
  inventoryItemGroupKey: z.string().min(1).max(100).optional(),
  title: z.string(),
  description: z.string(),
  aspects: z.record(z.array(z.string())),
  imageUrls: z.array(z.string().url()),
  variantSKUs: z.array(z.string().min(1)).max(250).optional(),
  variesBy: z.object({
    aspectsImageVariesBy: z.array(z.string()).optional(),
    specifications: z.array(z.object({ name: z.string().min(1), values: z.array(z.string()) }).passthrough()),
  }).passthrough(),
}).passthrough();

/** Validate the provider body without manufacturing an echoed request-path key. */
export function normalizeEbayObservedInventoryItemGroup(response: unknown): EbayInventoryItemGroup {
  const parsed = ebayObservedInventoryItemGroupSchema.safeParse(response);
  if (!parsed.success) {
    throw new EbayListingSyncError(
      "EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
      `The eBay group response is invalid (fields ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ").slice(0, 400)}).`,
    );
  }
  return parsed.data;
}

export function normalizeEbayObservedOffers(
  response: unknown,
): EbayObservedOffer[] {
  const parsed = ebayOffersResponseSchema.safeParse(response);
  if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
    "eBay returned an invalid offer response. Review the current listing identity before another write.");
  return parsed.data.offers.map((offer) => {
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
  quantityAdmission?: () => Promise<EbayQuantityRequestAdmission>;
  expectedAccountId?: string;
  expectedConnectionId?: number;
}

export interface EbayRouteListingLifecycleClient
  extends EbayListingConnectorClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<EbayInventoryItemGroup | null>;
  withdrawOffer(offerId: string): Promise<void>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
  bulkUpdatePriceQuantity(
    request: EbayBulkPriceQuantityRequest,
  ): Promise<EbayBulkPriceQuantityResponse>;
  deleteOffer(offerId: string): Promise<void>;
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
  deleteInventoryItem(sku: string): Promise<void>;
}

function createEbayRouteRequest(input: EbayRouteClientInput) {
  const raw = async <T>(request: EbayQuantityHttpRequest): Promise<T> =>
    input.onRateLimit
      ? ((await ebayApiRequestWithRateNotify(
          request.method,
          request.path,
          input.accessToken,
          request.body,
          input.onRateLimit,
        )) as T)
      : ((await ebayApiRequest(
          request.method,
          request.path,
          input.accessToken,
          request.body,
        )) as T);
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    if (!ebayQuantityMutationIdentity(method, path, body))
      return raw<T>({ method, path, body });
    const admission = input.quantityAdmission
      ? await input.quantityAdmission()
      : await (async () => {
          const account =
            await getAuthService()?.getVerifiedProviderAccount(EBAY_CHANNEL_ID);
          if (!account)
            throw new EbayListingSyncError("EBAY_SYNC_AUTH_REQUIRED",
              "Provider-verified eBay account identity is required for listing publication.",
            );
          if (
            input.expectedAccountId &&
            account.externalAccountId !== input.expectedAccountId
          )
            throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The verified eBay account changed before the listing write.");
          const { createChannelEbayQuantityRequestAdmission } = await import(
        "../../inventory-planning/quantity-publication"
          );
          return createChannelEbayQuantityRequestAdmission({
            channelId: EBAY_CHANNEL_ID,
            externalAccountId: account.externalAccountId,
            expectedConnectionId: input.expectedConnectionId,
          });
        })();
    return executeAdmittedEbayQuantityRequest<T>(
      { method, path, body },
      admission,
      raw,
    );
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
        if (isMissingEbayInventoryResource(error)) {
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
        if (isMissingEbayInventoryResource(error)) {
          return { offers: [] };
        }
        throw error;
      }
    },
    createOffer: async (offer) => {
      const response = await request<unknown>(
        "POST",
        "/sell/inventory/v1/offer",
        offer,
      );
      const parsed = z.object({ offerId: z.string().trim().min(1).max(255) }).safeParse(response);
      if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
        "eBay create offer did not return a valid offer id. The offer may exist; review the existing listing before another publication attempt.");
      return parsed.data.offerId;
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
      return normalizePublishedListingResponse(await request<unknown>(
        "POST",
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      ));
    },
    publishOfferByInventoryItemGroup: async (
      inventoryItemGroupKey,
      marketplaceId,
    ) => {
      return normalizePublishedListingResponse(await request<unknown>(
        "POST",
        "/sell/inventory/v1/offer/publish_by_inventory_item_group",
        { inventoryItemGroupKey, marketplaceId },
      ));
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
        return normalizeEbayObservedInventoryItemGroup(await request<unknown>(
          "GET",
          `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
        ));
      } catch (error: unknown) {
        if (isMissingEbayInventoryResource(error)) return null;
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
      return await request<EbayBulkPriceQuantityResponse>(
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

/** Read each exact SKU and its listing group through the same external photo reader as the adapter. */
export async function getExistingEbayListingPhotos(input: {
  accessToken: string;
  groupKey: string | null;
  variants: readonly EbayPhotoVariant[];
}): Promise<EbayListingPhotoPlan> {
  return readExistingEbayListingPhotos(
    createEbayRouteListingLifecycleClient({ accessToken: input.accessToken }),
    input,
  );
}
