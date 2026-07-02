import { describe, expect, it, vi } from "vitest";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorClient,
} from "../../listing-connectors/ebay-listing.connector";
import { ShopifyMarketplaceListingConnector } from "../../listing-connectors/shopify-listing.connector";
import type { BuiltInventoryItem, BuiltItemGroup, BuiltOffer } from "../../adapters/ebay/ebay-listing-builder";
import type { EbayInventoryItem, EbayOffer } from "../../adapters/ebay/ebay-types";

describe("marketplace listing connectors", () => {
  it("publishes eBay listings through one connector client", async () => {
    const calls: string[] = [];
    const client: EbayListingConnectorClient = {
      getInventoryItem: vi.fn(async () => null),
      createOrReplaceInventoryItem: vi.fn(async () => {
        calls.push("put_inventory");
      }),
      getOffers: vi.fn(async () => {
        calls.push("get_offers");
        return { offers: [] };
      }),
      createOffer: vi.fn(async () => {
        calls.push("create_offer");
        return "offer-1";
      }),
      updateOffer: vi.fn(async () => {
        calls.push("update_offer");
      }),
      createOrReplaceInventoryItemGroup: vi.fn(async () => {
        calls.push("put_group");
      }),
      publishOffer: vi.fn(async () => {
        calls.push("publish_offer");
        return { listingId: "listing-1" };
      }),
      publishOfferByInventoryItemGroup: vi.fn(async () => {
        calls.push("publish_group");
        return { listingId: "listing-group" };
      }),
    };

    const inventoryItems: BuiltInventoryItem[] = [
      {
        sku: "SKU-1",
        payload: {
          condition: "NEW",
          product: { title: "Test", imageUrls: [], aspects: {} },
          availability: { shipToLocationAvailability: { quantity: 3 } },
        } satisfies Omit<EbayInventoryItem, "sku">,
      },
    ];
    const offers: BuiltOffer[] = [
      {
        sku: "SKU-1",
        variantId: 10,
        payload: {
          sku: "SKU-1",
          marketplaceId: "EBAY_US",
          format: "FIXED_PRICE",
          availableQuantity: 3,
          categoryId: "123",
          listingPolicies: {
            fulfillmentPolicyId: "fulfillment",
            paymentPolicyId: "payment",
            returnPolicyId: "return",
          },
          merchantLocationKey: "warehouse",
          pricingSummary: { price: { value: "9.99", currency: "USD" } },
        } satisfies EbayOffer,
      },
    ];

    const connector = new EbayMarketplaceListingConnector();
    const result = await connector.pushListing({
      client,
      draft: {
        productId: 1,
        marketplaceId: "EBAY_US",
        inventoryItems,
        offers,
        itemGroup: null,
        publishMode: "publish",
        hasExistingExternalIds: false,
      },
    });

    expect(calls).toEqual(["put_inventory", "get_offers", "create_offer", "publish_offer"]);
    expect(result).toMatchObject({
      productId: 1,
      status: "created",
      externalProductId: "listing-1",
      externalOfferIds: { 10: "offer-1" },
      published: true,
    });
  });

  it("uses known eBay offer ids without probing the marketplace", async () => {
    const client: EbayListingConnectorClient = {
      getInventoryItem: vi.fn(async () => null),
      createOrReplaceInventoryItem: vi.fn(async () => undefined),
      getOffers: vi.fn(async () => ({ offers: [] })),
      createOffer: vi.fn(async () => "new-offer"),
      updateOffer: vi.fn(async () => undefined),
      createOrReplaceInventoryItemGroup: vi.fn(async () => undefined),
      publishOffer: vi.fn(async () => ({ listingId: "listing-1" })),
      publishOfferByInventoryItemGroup: vi.fn(async () => ({ listingId: "listing-group" })),
    };

    const connector = new EbayMarketplaceListingConnector();
    await connector.pushListing({
      client,
      draft: {
        productId: 1,
        marketplaceId: "EBAY_US",
        inventoryItems: [
          {
            sku: "SKU-1",
            payload: {
              condition: "NEW",
              product: { title: "Test", imageUrls: [], aspects: {} },
              availability: { shipToLocationAvailability: { quantity: 1 } },
            } satisfies Omit<EbayInventoryItem, "sku">,
          },
        ],
        offers: [
          {
            sku: "SKU-1",
            variantId: 10,
            payload: {
              sku: "SKU-1",
              marketplaceId: "EBAY_US",
              format: "FIXED_PRICE",
              availableQuantity: 1,
              categoryId: "123",
              listingPolicies: {
                fulfillmentPolicyId: "fulfillment",
                paymentPolicyId: "payment",
                returnPolicyId: "return",
              },
              merchantLocationKey: "warehouse",
              pricingSummary: { price: { value: "9.99", currency: "USD" } },
            } satisfies EbayOffer,
          },
        ],
        itemGroup: null,
        publishMode: "stage",
        hasExistingExternalIds: true,
        existingExternalProductId: "listing-1",
        existingOfferIdsByVariantId: { 10: "known-offer" },
      },
    });

    expect(client.getOffers).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.updateOffer).toHaveBeenCalledWith(
      "known-offer",
      expect.objectContaining({ offerId: "known-offer" }),
    );
  });

  it("syncs existing eBay listings by updating inventory, existing offers, and item groups", async () => {
    const calls: string[] = [];
    const client: EbayListingConnectorClient = {
      getInventoryItem: vi.fn(async () => null),
      createOrReplaceInventoryItem: vi.fn(async () => {
        calls.push("put_inventory");
      }),
      getOffers: vi.fn(async () => {
        calls.push("get_offers");
        return {
          offers: [
          {
            offerId: "offer-1",
            sku: "SKU-1",
            marketplaceId: "EBAY_US",
            format: "FIXED_PRICE",
            availableQuantity: 1,
            categoryId: "123",
            listingPolicies: {
              fulfillmentPolicyId: "old-fulfillment",
              paymentPolicyId: "payment",
              returnPolicyId: "return",
            },
            merchantLocationKey: "warehouse",
            pricingSummary: { price: { value: "8.99", currency: "USD" } },
          },
          ],
        };
      }),
      createOffer: vi.fn(async () => "new-offer"),
      updateOffer: vi.fn(async () => {
        calls.push("update_offer");
      }),
      createOrReplaceInventoryItemGroup: vi.fn(async () => {
        calls.push("put_group");
      }),
      publishOffer: vi.fn(async () => ({ listingId: "listing-1" })),
      publishOfferByInventoryItemGroup: vi.fn(async () => ({ listingId: "listing-group" })),
    };

    const inventoryItems: BuiltInventoryItem[] = [
      {
        sku: "SKU-1",
        payload: {
          condition: "NEW",
          product: { title: "Test", imageUrls: [], aspects: {} },
          availability: { shipToLocationAvailability: { quantity: 4 } },
        } satisfies Omit<EbayInventoryItem, "sku">,
      },
    ];
    const offers: BuiltOffer[] = [
      {
        sku: "SKU-1",
        variantId: 10,
        payload: {
          sku: "SKU-1",
          marketplaceId: "EBAY_US",
          format: "FIXED_PRICE",
          availableQuantity: 4,
          categoryId: "123",
          listingPolicies: {
            fulfillmentPolicyId: "new-fulfillment",
            paymentPolicyId: "payment",
            returnPolicyId: "return",
          },
          merchantLocationKey: "warehouse",
          pricingSummary: { price: { value: "9.99", currency: "USD" } },
        } satisfies EbayOffer,
      },
    ];
    const itemGroup: BuiltItemGroup = {
      groupKey: "GROUP-1",
      payload: {
        aspects: {},
        description: "Test group",
        imageUrls: [],
        title: "Test group",
        variantSKUs: ["SKU-1"],
        variesBy: { specifications: [{ name: "Size", values: ["One"] }] },
      },
    };

    const connector = new EbayMarketplaceListingConnector();
    const result = await connector.syncExistingListing({
      client,
      draft: {
        productId: 1,
        marketplaceId: "EBAY_US",
        inventoryItems,
        offers,
        itemGroup,
      },
    });

    expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.publishOffer).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(calls).toEqual(["put_group", "put_inventory", "get_offers", "update_offer"]);
    expect(client.updateOffer).toHaveBeenCalledWith(
      "offer-1",
      expect.objectContaining({ offerId: "offer-1" }),
    );
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith("GROUP-1", itemGroup.payload);
    expect(result).toMatchObject({
      productId: 1,
      updatedInventorySkus: ["SKU-1"],
      updatedOfferIds: { 10: "offer-1" },
      missingOfferVariantIds: [],
      policyChangedVariantIds: [10],
      itemGroupUpdated: true,
    });
  });

  it("inspects eBay listing status from inventory item and offer state", async () => {
    const client: EbayListingConnectorClient = {
      getInventoryItem: vi.fn(async (sku) => {
        if (sku === "MISSING") return null;
        return {
          sku,
          condition: "NEW",
          product: { title: "Test", imageUrls: [], aspects: {} },
          availability: { shipToLocationAvailability: { quantity: 1 } },
        } satisfies EbayInventoryItem;
      }),
      createOrReplaceInventoryItem: vi.fn(async () => undefined),
      getOffers: vi.fn(async (sku) => ({
        offers: sku === "ACTIVE"
          ? [
              {
                offerId: "offer-active",
                sku,
                marketplaceId: "EBAY_US",
                format: "FIXED_PRICE",
                availableQuantity: 1,
                categoryId: "123",
                listingPolicies: {
                  fulfillmentPolicyId: "fulfillment",
                  paymentPolicyId: "payment",
                  returnPolicyId: "return",
                },
                merchantLocationKey: "warehouse",
                pricingSummary: { price: { value: "9.99", currency: "USD" } },
                status: "PUBLISHED",
              } as EbayOffer & { offerId: string; status: string },
            ]
          : [],
      })),
      createOffer: vi.fn(async () => "new-offer"),
      updateOffer: vi.fn(async () => undefined),
      createOrReplaceInventoryItemGroup: vi.fn(async () => undefined),
      publishOffer: vi.fn(async () => ({ listingId: "listing-1" })),
      publishOfferByInventoryItemGroup: vi.fn(async () => ({ listingId: "listing-group" })),
    };

    const connector = new EbayMarketplaceListingConnector();

    await expect(connector.inspectListingStatus({ client, sku: "MISSING", marketplaceId: "EBAY_US" }))
      .resolves.toEqual({ inventoryItemExists: false, hasActiveOffer: false });
    await expect(connector.inspectListingStatus({ client, sku: "ENDED", marketplaceId: "EBAY_US" }))
      .resolves.toEqual({ inventoryItemExists: true, hasActiveOffer: false });
    await expect(connector.inspectListingStatus({ client, sku: "ACTIVE", marketplaceId: "EBAY_US" }))
      .resolves.toEqual({ inventoryItemExists: true, hasActiveOffer: true });
  });

  it("pushes Shopify productSet listings through the shared connector", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          productSet: {
            product: {
              id: "gid://shopify/Product/1",
              variants: {
                nodes: [{ id: "gid://shopify/ProductVariant/2", sku: "SKU-1" }],
              },
            },
            userErrors: [],
          },
        },
      }),
    })) as unknown as typeof fetch;

    const connector = new ShopifyMarketplaceListingConnector({ fetchImpl });
    const result = await connector.pushProductSet({
      credentials: {
        shopDomain: "store.myshopify.com",
        accessToken: "token",
        apiVersion: "2026-04",
      },
      productSet: {
        title: "Test",
        variants: [{ sku: "SKU-1" }],
      },
      existingExternalListingId: null,
      sku: "SKU-1",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://store.myshopify.com/admin/api/2026-04/graphql.json",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({
      status: "created",
      externalListingId: "gid://shopify/Product/1",
      externalOfferId: "gid://shopify/ProductVariant/2",
    });
  });
});
