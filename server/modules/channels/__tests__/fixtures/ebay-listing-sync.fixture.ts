import { vi } from "vitest";
import type { PreparedEbayListingSync } from "../../ebay-listing-sync.service";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type {
  EbayInventoryItem,
  EbayInventoryItemGroup,
} from "../../adapters/ebay/ebay-types";
import type {
  EbayObservedOffer,
  EbayListingLifecycleClient,
} from "../../listing-connectors/ebay-listing.connector";
export const syncIdentity: EbayListingSyncIdentity = {
  channelId: 1,
  connectionId: 1,
  productId: 20,
  accountId: "verified-account",
  marketplaceId: "EBAY_US",
  groupKey: "PACK",
  variants: [
    {
      variantId: 101,
      sku: "P5",
      externalSku: "P5",
      offerId: "offer-101",
      listingId: "listing-20",
    },
  ],
};
export function syncProviderFixture() {
  let quantity = 7;
  let item: EbayInventoryItem = {
    sku: "P5",
    condition: "NEW",
    product: {
      title: "Pack",
      description: "Description",
      imageUrls: ["https://example.com/pack.jpg"],
    },
    availability: { shipToLocationAvailability: { quantity } },
  };
  let offer: EbayObservedOffer = {
    sku: "P5",
    offerId: "offer-101",
    status: "PUBLISHED",
    listingId: "listing-20",
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: quantity,
    categoryId: "183454",
    merchantLocationKey: "HQ",
    listingPolicies: {
      paymentPolicyId: "payment",
      returnPolicyId: "return",
      fulfillmentPolicyId: "fulfillment",
    },
    pricingSummary: { price: { value: "11.49", currency: "USD" } },
  };
  let group: EbayInventoryItemGroup = {
    title: "Pack",
    description: "Description",
    imageUrls: ["https://example.com/pack.jpg"],
    variantSKUs: ["P5"],
    aspects: { Brand: ["Shellz"] },
    variesBy: { specifications: [{ name: "Pack Size", values: ["5"] }] },
  };
  const client: EbayListingLifecycleClient = {
    getInventoryItem: vi.fn(async () => structuredClone(item)),
    getOffers: vi.fn(async () => ({ offers: [structuredClone(offer)] })),
    getInventoryItemGroup: vi.fn(async () => structuredClone(group)),
    createOrReplaceInventoryItem: vi.fn(async (sku, payload) => {
      item = { ...structuredClone(payload), sku };
    }),
    updateOffer: vi.fn(async (id, payload) => {
      offer = {
        ...structuredClone(payload),
        offerId: id,
        status: "PUBLISHED",
        listingId: "listing-20",
      };
    }),
    createOrReplaceInventoryItemGroup: vi.fn(async (_key, payload) => {
      const { inventoryItemGroupKey: _requestKey, ...content } = structuredClone(payload) as EbayInventoryItemGroup;
      group = content;
    }),
    createOffer: vi.fn(),
    publishOffer: vi.fn(),
    publishOfferByInventoryItemGroup: vi.fn(),
    withdrawOfferByInventoryItemGroup: vi.fn(),
    bulkUpdatePriceQuantity: vi.fn(),
    deleteInventoryItemGroup: vi.fn(),
  };
  const prepare = vi.fn(
    async (): Promise<PreparedEbayListingSync> => ({
      identity: structuredClone(syncIdentity),
      client,
      draft: {
        productId: 20,
        marketplaceId: "EBAY_US",
        inventoryItems: [
          {
            sku: "P5",
            payload: {
              ...item,
              availability: { shipToLocationAvailability: { quantity } },
              product: { ...item.product, title: "Latest catalog title" },
            },
          },
        ],
        offers: [
          {
            sku: "P5",
            variantId: 101,
            payload: { ...offer, availableQuantity: quantity },
          },
        ],
        itemGroup: {
          groupKey: "PACK",
          payload: { ...group, title: "Latest catalog title" },
        },
      },
      variants: [
        {
          variantId: 101,
          sku: "P5",
          productName: "Pack",
          priceCents: 1149,
          priceChanged: true,
        },
      ],
    }),
  );
  return {
    client,
    prepare,
    setQuantity: (value: number) => {
      quantity = value;
    },
    currentItem: () => item,
    currentGroup: () => group,
  };
}
