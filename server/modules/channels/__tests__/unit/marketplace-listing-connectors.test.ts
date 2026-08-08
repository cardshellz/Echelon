import { describe, expect, it, vi } from "vitest";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorClient,
  type EbayListingConnectorDraft,
  type EbayListingLifecycleClient,
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

    expect(calls).toEqual(["get_offers", "put_inventory", "create_offer", "publish_offer"]);
    expect(result).toMatchObject({
      productId: 1,
      status: "created",
      externalProductId: "listing-1",
      externalOfferIds: { 10: "offer-1" },
      published: true,
    });
  });

  it("uses known eBay offer ids without probing the marketplace", async () => {
    const calls: string[] = [];
    const client: EbayListingConnectorClient = {
      getInventoryItem: vi.fn(async () => null),
      createOrReplaceInventoryItem: vi.fn(async () => {
        calls.push("put_inventory");
      }),
      getOffers: vi.fn(async () => ({ offers: [] })),
      createOffer: vi.fn(async () => "new-offer"),
      updateOffer: vi.fn(async () => {
        calls.push("update_offer");
      }),
      createOrReplaceInventoryItemGroup: vi.fn(async () => undefined),
      publishOffer: vi.fn(async () => ({ listingId: "listing-1" })),
      publishOfferByInventoryItemGroup: vi.fn(async () => ({ listingId: "listing-group" })),
    };
    const knownOffers: BuiltOffer[] = [
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
    ];

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
        offers: knownOffers,
        itemGroup: null,
        publishMode: "stage",
        hasExistingExternalIds: true,
        existingExternalProductId: "listing-1",
        existingOfferIdsByVariantId: { 10: "known-offer" },
      },
    });

    expect(client.getOffers).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(calls).toEqual(["update_offer", "put_inventory"]);
    expect(client.updateOffer).toHaveBeenCalledWith(
      "known-offer",
      expect.objectContaining({ offerId: "known-offer" }),
    );
    expect(knownOffers[0].payload).not.toHaveProperty("offerId");
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
    expect(calls).toEqual(["get_offers", "update_offer", "put_inventory", "put_group"]);
    expect(client.updateOffer).toHaveBeenCalledWith(
      "offer-1",
      expect.objectContaining({ offerId: "offer-1" }),
    );
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith("GROUP-1", itemGroup.payload);
    expect(offers[0].payload).not.toHaveProperty("offerId");
    expect(result).toMatchObject({
      productId: 1,
      updatedInventorySkus: ["SKU-1"],
      updatedOfferIds: { 10: "offer-1" },
      missingOfferVariantIds: [],
      policyChangedVariantIds: [10],
      itemGroupUpdated: true,
    });

    vi.mocked(client.getOffers).mockResolvedValueOnce({ offers: [] });
    vi.mocked(client.createOrReplaceInventoryItemGroup).mockClear();

    const missingOfferResult = await connector.syncExistingListing({
      client,
      draft: {
        productId: 1,
        marketplaceId: "EBAY_US",
        inventoryItems,
        offers,
        itemGroup,
      },
    });

    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(missingOfferResult).toMatchObject({
      missingOfferVariantIds: [10],
      itemGroupUpdated: false,
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
      .resolves.toEqual({ inventoryItemExists: false, hasActiveOffer: false, availableQuantity: null });
    await expect(connector.inspectListingStatus({ client, sku: "ENDED", marketplaceId: "EBAY_US" }))
      .resolves.toEqual({ inventoryItemExists: true, hasActiveOffer: false, availableQuantity: 0 });
    await expect(connector.inspectListingStatus({ client, sku: "ACTIVE", marketplaceId: "EBAY_US" }))
      .resolves.toEqual({ inventoryItemExists: true, hasActiveOffer: true, availableQuantity: 1 });
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

describe("explicit eBay listing rebuild lifecycle", () => {
  it("previews arbitrary stale and added variation membership without mutation", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    const connector = new EbayMarketplaceListingConnector();

    const preview = await connector.previewListingRebuild({
      client,
      draft: makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]),
      currentExternalListingId: "listing-old",
    });

    expect(preview).toMatchObject({
      sourceState: "active",
      currentSkus: ["CATALOG-KEEP", "CATALOG-OLD"],
      desiredSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      addedSkus: ["CATALOG-NEW"],
      removedSkus: ["CATALOG-OLD"],
      rebuildRequired: true,
    });
    expect(preview.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).not.toHaveBeenCalled();
  });

  it("previews a group with an inactive historical variation", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: sku === "CATALOG-OLD"
        ? [{
            offerId: "offer-old",
            sku,
            marketplaceId: "EBAY_US" as const,
            format: "FIXED_PRICE" as const,
            availableQuantity: 0,
            categoryId: "123",
            listingPolicies: {
              fulfillmentPolicyId: "fulfillment",
              paymentPolicyId: "payment",
              returnPolicyId: "return",
            },
            merchantLocationKey: "warehouse",
            pricingSummary: { price: { value: "9.99", currency: "USD" } },
            status: "UNPUBLISHED",
          }]
        : [{
            offerId: "offer-keep",
            listingId: "listing-old",
            sku,
            marketplaceId: "EBAY_US" as const,
            format: "FIXED_PRICE" as const,
            availableQuantity: 5,
            categoryId: "123",
            listingPolicies: {
              fulfillmentPolicyId: "fulfillment",
              paymentPolicyId: "payment",
              returnPolicyId: "return",
            },
            merchantLocationKey: "warehouse",
            pricingSummary: { price: { value: "9.99", currency: "USD" } },
            status: "PUBLISHED",
          }],
    }));
    const connector = new EbayMarketplaceListingConnector();

    await expect(connector.previewListingRebuild({
      client,
      draft: makeGroupedDraft(["CATALOG-KEEP"]),
      currentExternalListingId: "listing-old",
    })).resolves.toMatchObject({
      sourceState: "active",
      currentSkus: ["CATALOG-KEEP", "CATALOG-OLD"],
      activeSkus: ["CATALOG-KEEP"],
      inactiveSkus: ["CATALOG-OLD"],
      desiredSkus: ["CATALOG-KEEP"],
      addedSkus: [],
      removedSkus: [],
      rebuildRequired: false,
    });
  });

  it("rejects a group member actively published under a different listing", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: [{
        offerId: `offer-${sku}`,
        listingId: sku === "CATALOG-OLD" ? "listing-other" : "listing-old",
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: "PUBLISHED",
      }],
    }));
    const connector = new EbayMarketplaceListingConnector();

    await expect(connector.previewListingRebuild({
      client,
      draft: makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]),
      currentExternalListingId: "listing-old",
    })).rejects.toThrow("belongs to a different listing");
  });
  it("updates reviewed variation membership in eBay dependency order without ending the listing", async () => {
    const calls: string[] = [];
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
      calls,
    });
    vi.mocked(client.publishOfferByInventoryItemGroup)
      .mockImplementation(async () => {
        calls.push("publish_group");
        return { listingId: "listing-old" };
      });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    await expect(connector.updateExistingListing({ client, draft, preview }))
      .resolves.toMatchObject({
        externalProductId: "listing-old",
        status: "updated",
        removedSkus: ["CATALOG-OLD"],
      });
    expect(client.getInventoryItemGroup).toHaveBeenCalledTimes(2);
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith(
      "CATALOG-GROUP",
      expect.objectContaining({ variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"] }),
    );
    expect(calls.indexOf("put_inventory")).toBeLessThan(calls.indexOf("put_group"));
    expect(calls.indexOf("put_group")).toBeLessThan(calls.indexOf("update_offer"));
    expect(calls.indexOf("update_offer")).toBeLessThan(calls.indexOf("publish_group"));
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).not.toHaveBeenCalled();
  });

  it("retains a removed variation at zero when eBay rejects desired membership with error 25013", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    vi.mocked(client.createOrReplaceInventoryItemGroup)
      .mockRejectedValueOnce(new Error("eBay API failed: errorId:25013 Invalid data in the Inventory Item Group"))
      .mockResolvedValueOnce(undefined);
    vi.mocked(client.getInventoryItem).mockResolvedValue({
      sku: "CATALOG-OLD",
      condition: "NEW",
      product: {
        title: "Generic catalog item",
        imageUrls: [],
        aspects: { Size: ["CATALOG-OLD"] },
      },
      availability: { shipToLocationAvailability: { quantity: 5 } },
    });
    vi.mocked(client.publishOfferByInventoryItemGroup)
      .mockResolvedValue({ listingId: "listing-old" });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    await expect(connector.updateExistingListing({ client, draft, preview }))
      .resolves.toMatchObject({ externalProductId: "listing-old" });
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenLastCalledWith(
      "CATALOG-GROUP",
      expect.objectContaining({
        variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW", "CATALOG-OLD"],
        variesBy: {
          specifications: [{
            name: "Size",
            values: ["CATALOG-KEEP", "CATALOG-NEW", "CATALOG-OLD"],
          }],
        },
      }),
    );
    expect(client.createOrReplaceInventoryItem).toHaveBeenCalledWith(
      "CATALOG-OLD",
      expect.objectContaining({
        availability: { shipToLocationAvailability: { quantity: 0 } },
      }),
    );
    expect(client.updateOffer).toHaveBeenCalledWith(
      "offer-CATALOG-OLD",
      expect.objectContaining({
        offerId: "offer-CATALOG-OLD",
        sku: "CATALOG-OLD",
        availableQuantity: 0,
      }),
    );
  });

  it("rejects an in-place update when live membership changed after review", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });
    vi.mocked(client.getInventoryItemGroup).mockResolvedValueOnce({
      inventoryItemGroupKey: "CATALOG-GROUP",
      aspects: {},
      description: "Changed group",
      imageUrls: [],
      title: "Changed group",
      variesBy: { specifications: [] },
      variantSKUs: ["CATALOG-KEEP"],
    });

    await expect(connector.updateExistingListing({ client, draft, preview }))
      .rejects.toThrow("The live eBay listing changed after review");
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
  it("previews and rebuilds a fully withdrawn source variation group", async () => {
    const calls: string[] = [];
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
      calls,
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: [{
        offerId: "offer-" + sku,
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: "UNPUBLISHED",
      }],
    }));
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);

    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    expect(preview).toMatchObject({
      sourceState: "withdrawn",
      currentSkus: ["CATALOG-KEEP", "CATALOG-OLD"],
      activeSkus: [],
      inactiveSkus: ["CATALOG-KEEP", "CATALOG-OLD"],
      desiredSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      addedSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      removedSkus: [],
      rebuildRequired: true,
    });
    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({ externalProductId: "listing-new" });
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("delete_group")).toBeLessThan(calls.indexOf("put_group"));
  });

  it("publishes a new listing when the desired group exists but every offer is withdrawn", async () => {
    const calls: string[] = [];
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      currentListingId: "listing-old",
      calls,
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: [{
        offerId: "offer-" + sku,
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: "UNPUBLISHED",
      }],
    }));
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);

    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    expect(preview).toMatchObject({
      sourceState: "withdrawn",
      currentSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      activeSkus: [],
      inactiveSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      desiredSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      addedSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      removedSkus: [],
      rebuildRequired: true,
    });
    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({
        externalProductId: "listing-new",
        removedSkus: [],
        published: true,
      });
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("delete_group")).toBeLessThan(calls.indexOf("publish_group"));
  });

  it("ends the confirmed source and publishes exactly the desired variations", async () => {
    const calls: string[] = [];
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
      calls,
    });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    const result = await connector.executeListingRebuild({ client, draft, preview });

    expect(result).toMatchObject({
      externalProductId: "listing-new",
      previousExternalListingId: "listing-old",
      removedSkus: ["CATALOG-OLD"],
      published: true,
    });
    expect(calls.indexOf("withdraw_group")).toBeLessThan(calls.indexOf("delete_group"));
    expect(calls.indexOf("delete_group")).toBeLessThan(calls.indexOf("put_group"));
    expect(calls.indexOf("put_group")).toBeLessThan(calls.indexOf("publish_group"));
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith(
      "CATALOG-GROUP",
      expect.objectContaining({ variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"] }),
    );
  });

  it("continues forward when a retry finds the old group already removed", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });
    vi.mocked(client.getInventoryItemGroup).mockResolvedValueOnce(null);

    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({ externalProductId: "listing-new" });
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).not.toHaveBeenCalled();
  });
  it("continues forward when the source was withdrawn but its group still exists", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: [{
        offerId: `offer-${sku}`,
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: "UNPUBLISHED",
      }],
    }));

    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({ externalProductId: "listing-new" });
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).toHaveBeenCalledTimes(1);
  });

  it("recovers a replacement already published before local mapping persistence", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    const connector = new EbayMarketplaceListingConnector();
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });
    vi.mocked(client.getInventoryItemGroup).mockResolvedValueOnce({
      inventoryItemGroupKey: "CATALOG-GROUP",
      aspects: {},
      description: "Replacement group",
      imageUrls: [],
      title: "Replacement group",
      variesBy: { specifications: [] },
      variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"],
    });
    vi.mocked(client.getOffers).mockImplementation(async (sku: string) => ({
      offers: [{
        offerId: `replacement-${sku}`,
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: "PUBLISHED",
        listingId: "listing-new",
      }],
    }));

    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({
        externalProductId: "listing-new",
        externalOfferIds: {
          1: "replacement-CATALOG-KEEP",
          2: "replacement-CATALOG-NEW",
        },
      });
    expect(client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.deleteInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
});

function makeGroupedDraft(skus: string[]): EbayListingConnectorDraft {
  return {
    productId: 999,
    marketplaceId: "EBAY_US",
    inventoryItems: skus.map((sku) => ({
      sku,
      payload: {
        condition: "NEW" as const,
        product: { title: "Generic catalog item", imageUrls: [], aspects: { Size: [sku] } },
        availability: { shipToLocationAvailability: { quantity: 5 } },
      },
    })),
    offers: skus.map((sku, index) => ({
      sku,
      variantId: index + 1,
      payload: {
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
      },
    })),
    itemGroup: {
      groupKey: "CATALOG-GROUP",
      payload: {
        aspects: {},
        description: "Generic catalog item",
        imageUrls: [],
        title: "Generic catalog item",
        variantSKUs: skus,
        variesBy: { specifications: [{ name: "Size", values: skus }] },
      },
    },
    publishMode: "publish",
    hasExistingExternalIds: true,
    existingExternalProductId: "listing-old",
  };
}

function makeLifecycleClient(input: {
  currentSkus: string[];
  currentListingId: string;
  calls?: string[];
}): EbayListingLifecycleClient & Record<string, ReturnType<typeof vi.fn>> {
  const calls = input.calls ?? [];
  return {
    getInventoryItemGroup: vi.fn(async () => ({
      inventoryItemGroupKey: "CATALOG-GROUP",
      aspects: {},
      description: "Current group",
      imageUrls: [],
      title: "Current group",
      variesBy: { specifications: [{ name: "Size", values: input.currentSkus }] },
      variantSKUs: input.currentSkus,
    })),
    getInventoryItem: vi.fn(async () => null),
    createOrReplaceInventoryItem: vi.fn(async () => { calls.push("put_inventory"); }),
    getOffers: vi.fn(async (sku: string) => ({
      offers: [{
        offerId: `offer-${sku}`,
        sku,
        marketplaceId: "EBAY_US" as const,
        format: "FIXED_PRICE" as const,
        availableQuantity: 5,
        categoryId: "123",
        listingPolicies: {
          fulfillmentPolicyId: "fulfillment",
          paymentPolicyId: "payment",
          returnPolicyId: "return",
        },
        merchantLocationKey: "warehouse",
        pricingSummary: { price: { value: "9.99", currency: "USD" } },
        status: input.currentSkus.includes(sku) ? "PUBLISHED" : "UNPUBLISHED",
        ...(input.currentSkus.includes(sku)
          ? { listing: { listingId: input.currentListingId, listingStatus: "ACTIVE" } }
          : {}),
      }],
    })),
    createOffer: vi.fn(async (offer: EbayOffer) => `offer-${offer.sku}`),
    updateOffer: vi.fn(async () => { calls.push("update_offer"); }),
    createOrReplaceInventoryItemGroup: vi.fn(async () => { calls.push("put_group"); }),
    publishOffer: vi.fn(async () => ({ listingId: "listing-new" })),
    publishOfferByInventoryItemGroup: vi.fn(async () => {
      calls.push("publish_group");
      return { listingId: "listing-new" };
    }),
    withdrawOfferByInventoryItemGroup: vi.fn(async () => { calls.push("withdraw_group"); }),
    deleteInventoryItemGroup: vi.fn(async () => { calls.push("delete_group"); }),
  } as EbayListingLifecycleClient & Record<string, ReturnType<typeof vi.fn>>;
}
describe("eBay grouped publish consistency", () => {
  it("retries only known transient offer visibility failures", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    vi.mocked(client.publishOfferByInventoryItemGroup)
      .mockRejectedValueOnce(new Error("eBay error 25604: Offer not found"))
      .mockRejectedValueOnce(new Error("eBay error 25703: offer not ready"))
      .mockResolvedValueOnce({ listingId: "listing-new" });
    const delay = vi.fn(async () => undefined);
    const connector = new EbayMarketplaceListingConnector({
      delay,
      groupPublishRetryDelaysMs: [10, 20],
    });
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .resolves.toMatchObject({ externalProductId: "listing-new" });
    expect(client.publishOfferByInventoryItemGroup).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map(([delayMs]) => delayMs).filter((delayMs) => delayMs > 0))
      .toEqual([10, 20]);
  });

  it("does not retry non-transient provider validation failures", async () => {
    const client = makeLifecycleClient({
      currentSkus: ["CATALOG-OLD", "CATALOG-KEEP"],
      currentListingId: "listing-old",
    });
    vi.mocked(client.publishOfferByInventoryItemGroup)
      .mockRejectedValue(new Error("Invalid fulfillment policy"));
    const delay = vi.fn(async () => undefined);
    const connector = new EbayMarketplaceListingConnector({
      delay,
      groupPublishRetryDelaysMs: [10, 20],
    });
    const draft = makeGroupedDraft(["CATALOG-KEEP", "CATALOG-NEW"]);
    const preview = await connector.previewListingRebuild({
      client,
      draft,
      currentExternalListingId: "listing-old",
    });

    await expect(connector.executeListingRebuild({ client, draft, preview }))
      .rejects.toThrow("Invalid fulfillment policy");
    expect(client.publishOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);
    expect(delay.mock.calls.map(([delayMs]) => delayMs).filter((delayMs) => delayMs > 0))
      .toEqual([]);
  });
});
