import { beforeEach, describe, expect, it } from "vitest";
import { createAdmittedEbayQuantityTestOwner } from "../../../channels/__tests__/fixtures/quantity-publication-admission";
import type {
  DropshipMarketplaceListingPushRequest,
} from "../../application/dropship-marketplace-listing-push-provider";
import { ShopifyDropshipListingPushProvider } from "../../infrastructure/dropship-shopify-listing-push.provider";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import { QuantityProviderEvidenceCollector, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

describe("dropship marketplace listing push providers", () => {
  beforeEach(() => { quantityAdmission = createAdmittedEbayQuantityTestOwner(); });
  it("retains daily-limit request evidence through the Dropship listing error wrapper", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([jsonResponse({ offers: [] }),new Response(JSON.stringify({ errors: [{ errorId: 25001,
      message: "You have exceeded your maximum call limit of 250 for item per day. Try back after 1 day." }] }),{ status: 400 })]);
    const provider = createEbayProvider(credentials,fetcher.fetch);
    const evidence: QuantityProviderResponseEvidence[] = [];
    const collector = new QuantityProviderEvidenceCollector({ start: async () => "1",finish: async (_id,row) => { evidence.push(row); } },
      () => new Date("2026-09-01T12:00:00.000Z"));
    await expect(collector.run(() => provider.pushListing(makeRequest({ platform: "ebay",marketplaceConfig: ebayMarketplaceConfig() }))))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" });
    expect(collector.provesTerminalRejection()).toBe(true);
    expect(evidence).toEqual([expect.objectContaining({ outcome: "rejected",httpStatus: 400,retryNotBefore: "2026-09-02T12:00:00.000Z" })]);
    expect(fetcher.calls).toHaveLength(2);
  });
  it("pushes Shopify listings through GraphQL productSet using deterministic money strings", async () => {
    const credentials = new FakeCredentialRepository(shopifyCredential());
    const fetcher = new FakeFetch([
      jsonResponse({
        data: {
          productSet: {
            product: {
              id: "gid://shopify/Product/900",
              variants: {
                nodes: [{ id: "gid://shopify/ProductVariant/901", sku: "SKU-101", title: "SKU-101" }],
              },
            },
            userErrors: [],
          },
        },
      }),
    ]);
    const provider = new ShopifyDropshipListingPushProvider(credentials, fetcher.fetch);

    const result = await provider.pushListing(makeRequest({ platform: "shopify" }));

    expect(result).toMatchObject({
      status: "created",
      externalListingId: "gid://shopify/Product/900",
      externalOfferId: "gid://shopify/ProductVariant/901",
    });
    expect(fetcher.calls[0]?.url).toBe("https://vendor-shop.myshopify.com/admin/api/2026-04/graphql.json");
    const body = JSON.parse(String(fetcher.calls[0]?.init.body));
    expect(body.variables.productSet).toMatchObject({
      title: "Toploader",
      status: "DRAFT",
      variants: [
        {
          sku: "SKU-101",
          price: "12.99",
        },
      ],
    });
  });

  it("sends eBay's placeholder MPN when the catalog has none, so publishing is not refused for the Brand and MPN pair", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await provider.pushListing(makeRequest({ platform: "ebay", marketplaceConfig: ebayMarketplaceConfig(), mpn: null }));

    const inventoryBody = JSON.parse(String(fetcher.calls[1]?.init.body));
    expect(inventoryBody.product).toMatchObject({
      brand: "Card Shellz",
      mpn: "Does Not Apply",
      aspects: expect.objectContaining({ MPN: ["Does Not Apply"] }),
    });
  });

  it("prefers an MPN item specific over eBay's placeholder", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await provider.pushListing(makeRequest({
      platform: "ebay", marketplaceConfig: ebayMarketplaceConfig(), mpn: null, itemSpecifics: { Size: ["35pt"], MPN: ["ARM-50"] },
    }));

    const inventoryBody = JSON.parse(String(fetcher.calls[1]?.init.body));
    expect(inventoryBody.product).toMatchObject({ mpn: "ARM-50", aspects: expect.objectContaining({ MPN: ["ARM-50"] }) });
  });

  it("creates an eBay staged offer without publishing when listing mode is draft_first", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    const result = await provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
    }));

    expect(result).toMatchObject({
      status: "created",
      externalListingId: "offer-101",
      externalOfferId: "offer-101",
      rawResult: { published: false },
    });
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET", "PUT", "POST", "PUT"]);
    expect(quantityAdmission.item.mock.calls.map(([sku]) => sku)).toEqual(["SKU-101", "SKU-101", "SKU-101"]);
    const inventoryBody = JSON.parse(String(fetcher.calls[1]?.init.body));
    expect(inventoryBody).toMatchObject({
      product: {
        title: "Toploader",
        imageUrls: ["https://cdn.example.test/toploader.jpg"],
        brand: "Card Shellz",
      },
      availability: {
        shipToLocationAvailability: { quantity: 4 },
      },
      packageWeightAndSize: {
        weight: { value: 100, unit: "GRAM" },
      },
    });
    const offerBody = JSON.parse(String(fetcher.calls[2]?.init.body));
    expect(offerBody).toMatchObject({
      marketplaceId: "EBAY_US",
      categoryId: "183438",
      merchantLocationKey: "cardshellz-dropship-wh-1",
      pricingSummary: { price: { value: "12.99", currency: "USD" } },
    });
  });

  it("retains the supplied photo intent and reuses an offer after a failure following its creation", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }), emptyResponse(), jsonResponse({ offerId: "offer-101" }),
      new Response("provider unavailable after offer creation", { status: 503 }),
      jsonResponse({ offers: [{ offerId: "offer-101" }] }), emptyResponse(), emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);
    const request = makeRequest({ platform: "ebay", marketplaceConfig: ebayMarketplaceConfig() });
    const uploaded = `https://catalog.example.com/api/catalog/images/9214/${"a".repeat(64)}.jpg`;
    request.listingIntent.imageUrls = [uploaded, "https://cdn.example.test/catalog.jpg", uploaded];
    const approvedInput = structuredClone(request);

    await expect(provider.pushListing(request)).rejects.toMatchObject({ context: { status: 503, retryable: true } });
    await provider.pushListing(request);

    const inventoryWrites = fetcher.calls.filter(call => call.init.method === "PUT" && call.url.endsWith("/inventory_item/SKU-101"));
    expect(inventoryWrites).toHaveLength(2);
    expect(inventoryWrites.map(call => JSON.parse(String(call.init.body)).product.imageUrls))
      .toEqual([[uploaded, "https://cdn.example.test/catalog.jpg"], [uploaded, "https://cdn.example.test/catalog.jpg"]]);
    expect(fetcher.calls.filter(call => call.init.method === "POST" && call.url.endsWith("/offer"))).toHaveLength(1);
    expect(request).toEqual(approvedInput);
  });

  it("uses the product category and optional seller Store categories instead of a store-wide category", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceCategoryId: "183439",
      storeCategoryNames: ["Shipping Supplies:Armalopes"],
      marketplaceConfig: {
        ...ebayMarketplaceConfig(),
        categoryId: "999999",
      },
    }));

    const offerBody = JSON.parse(String(fetcher.calls[2]?.init.body));
    expect(offerBody).toMatchObject({
      categoryId: "183439",
      storeCategoryNames: ["Shipping Supplies:Armalopes"],
    });
  });

  it("fails before calling eBay when a listing intent has no product browse category", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceCategoryId: null,
      marketplaceConfig: {
        ...ebayMarketplaceConfig(),
        categoryId: "183454",
      },
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_BROWSE_CATEGORY_REQUIRED",
      context: { productVariantId: 101, retryable: false },
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("publishes an eBay offer when listing mode is live", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [{ offerId: "offer-101" }] }),
      emptyResponse(),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101", sku: "SKU-101", marketplaceId: "EBAY_US" }),
      jsonResponse({ listingId: "listing-101" }),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    const result = await provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }));

    expect(result).toMatchObject({
      status: "created",
      externalListingId: "listing-101",
      externalOfferId: "offer-101",
      rawResult: { published: true },
    });
    expect(fetcher.calls[3]?.url).toContain("/sell/inventory/v1/offer/offer-101");
    expect(fetcher.calls[3]?.init.method).toBe("GET");
    expect(fetcher.calls[4]?.url).toContain("/sell/inventory/v1/offer/offer-101/publish");
    expect(quantityAdmission.item.mock.calls.map(([sku]) => sku)).toEqual(["SKU-101", "SKU-101", "SKU-101"]);

    // eBay refuses a Sell API call without its locale headers (25709 "Invalid
    // value for header Accept-Language"); every call carries them like the
    // channel client's, the content locale on writes only.
    for (const call of fetcher.calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("Accept-Language")).toBe("en-US");
      expect(headers.get("X-EBAY-C-MARKETPLACE-ID")).toBe("EBAY_US");
      expect(headers.get("Content-Language")).toBe(call.init.method === "GET" ? null : "en-US");
    }
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET", "PUT", "PUT", "GET", "POST"]);
  });

  it("creates an authenticated eBay replacement lifecycle client for a Dropship store", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ inventoryItemGroupKey: "GROUP-V2", variantSKUs: ["SKU-101"] }),
      jsonResponse({ inventoryItemGroupKey: "GROUP-V2", variantSKUs: ["SKU-101"] }),
      jsonResponse({ inventoryItemGroupKey: "GROUP-V2", variantSKUs: ["SKU-101"] }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    const session = await provider.createReplacementLifecycleClient({
      vendorId: 10,
      storeConnectionId: 22,
      marketplaceConfig: ebayMarketplaceConfig(),
    });
    const group = await session.client.getInventoryItemGroup("GROUP-V2");
    await session.client.withdrawOfferByInventoryItemGroup("GROUP-V2", "EBAY_US");

    expect(session.marketplaceId).toBe("EBAY_US");
    expect(group).toMatchObject({ variantSKUs: ["SKU-101"] });
    expect(fetcher.calls.map((call) => ({ url: call.url, method: call.init.method }))).toEqual([
      {
        url: "https://api.ebay.com/sell/inventory/v1/inventory_item_group/GROUP-V2",
        method: "GET",
      },
      {
        url: "https://api.ebay.com/sell/inventory/v1/inventory_item_group/GROUP-V2",
        method: "GET",
      },
      {
        url: "https://api.ebay.com/sell/inventory/v1/inventory_item_group/GROUP-V2",
        method: "GET",
      },
      {
        url: "https://api.ebay.com/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
        method: "POST",
      },
    ]);
  });
  it("previews and executes a generic grouped rebuild through the shared eBay connector", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const currentGroup = {
      inventoryItemGroupKey: "CATALOG-GROUP",
      variantSKUs: ["CATALOG-KEEP", "CATALOG-STALE"],
      aspects: {},
      description: "Catalog group",
      imageUrls: ["https://cdn.example.test/catalog.jpg"],
      title: "Catalog group",
      variesBy: { specifications: [] },
    };
    const publishedKeep = {
      offers: [{ offerId: "offer-keep", listingId: "listing-old", status: "PUBLISHED" }],
    };
    const publishedStale = {
      offers: [{ offerId: "offer-stale", listingId: "listing-old", status: "PUBLISHED" }],
    };
    const fetcher = new FakeFetch([
      jsonResponse(currentGroup),
      jsonResponse(publishedKeep),
      jsonResponse(publishedStale),
      jsonResponse(currentGroup),
      jsonResponse(publishedKeep),
      jsonResponse(publishedStale),
      jsonResponse(currentGroup),
      jsonResponse(currentGroup),
      emptyResponse(),
      jsonResponse(currentGroup),
      jsonResponse(currentGroup),
      emptyResponse(),
      jsonResponse({ offers: [{ offerId: "offer-keep", status: "UNPUBLISHED" }] }),
      jsonResponse({ offers: [{ offerId: "offer-new", status: "UNPUBLISHED" }] }),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
      jsonResponse({ ...currentGroup, variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"] }),
      jsonResponse({ ...currentGroup, variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"] }),
      jsonResponse({ listingId: "listing-new" }),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);
    const draft = makeGroupedRebuildDraft();

    const preview = await provider.previewListingRebuild({
      vendorId: 10,
      storeConnectionId: 22,
      marketplaceConfig: ebayMarketplaceConfig(),
      currentExternalListingId: "listing-old",
      draft,
    });
    const result = await provider.executeListingRebuild({
      vendorId: 10,
      storeConnectionId: 22,
      marketplaceConfig: ebayMarketplaceConfig(),
      draft,
      preview,
    });

    expect(preview).toMatchObject({
      groupKey: "CATALOG-GROUP",
      currentExternalListingId: "listing-old",
      currentSkus: ["CATALOG-KEEP", "CATALOG-STALE"],
      desiredSkus: ["CATALOG-KEEP", "CATALOG-NEW"],
      addedSkus: ["CATALOG-NEW"],
      removedSkus: ["CATALOG-STALE"],
      rebuildRequired: true,
    });
    expect(result).toMatchObject({
      externalProductId: "listing-new",
      previousExternalListingId: "listing-old",
      removedSkus: ["CATALOG-STALE"],
      published: true,
    });
    expect(fetcher.calls.map((call) => call.init.method)).toEqual([
      "GET", "GET", "GET",
      "GET", "GET", "GET", "GET", "GET", "POST", "GET", "GET", "DELETE",
      "GET", "GET", "PUT", "PUT", "PUT", "PUT", "PUT", "GET", "GET", "POST",
    ]);
    expect(quantityAdmission.group).toHaveBeenLastCalledWith("CATALOG-GROUP", ["CATALOG-KEEP", "CATALOG-NEW"], expect.any(Function));
    expect(quantityAdmission.reducing.mock.calls).toEqual([
      ["group:CATALOG-GROUP", expect.any(Function), ["CATALOG-KEEP", "CATALOG-STALE"]],
      ["group:CATALOG-GROUP", expect.any(Function), ["CATALOG-KEEP", "CATALOG-STALE"]],
    ]);
  });
  it("lists a SKU that has no offer yet: eBay's 404 on the offer lookup means none, so the offer is created and published", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ errors: [{ errorId: 25713, domain: "API_INVENTORY", category: "REQUEST", message: "This Offer is not available." }] }, 404),
      emptyResponse(),
      jsonResponse({ offerId: "offer-201" }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-201", sku: "SKU-101", marketplaceId: "EBAY_US" }),
      jsonResponse({ listingId: "listing-201" }),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    const result = await provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }));

    expect(result).toMatchObject({ status: "created", externalListingId: "listing-201", externalOfferId: "offer-201", rawResult: { published: true } });
    expect(fetcher.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/inventory_item/SKU-101",
      "POST /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/offer/offer-201",
      "GET /sell/inventory/v1/offer/offer-201",
      "POST /sell/inventory/v1/offer/offer-201/publish",
    ]);
    expect(credentials.authFailures).toHaveLength(0);
  });

  it("still fails the push when a call other than the offer lookup answers 404", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ errors: [{ errorId: 25713, message: "This Offer is not available." }] }, 404),
      jsonResponse({ errors: [{ errorId: 25710, message: "We didn't find the entity you are requesting." }] }, 404),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 404: 25710 We didn't find the entity you are requesting.",
      context: { status: 404, retryable: false, endpoint: "PUT /sell/inventory/v1/inventory_item/SKU-101" },
    });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("does not invalidate store credentials for an ordinary eBay listing API 400", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ errors: [{ message: "Invalid package details" }] }, 400),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 400: Invalid package details",
      context: {
        status: 400, retryable: false, providerErrors: [{ errorId: null, message: "Invalid package details" }],
        endpoint: "GET /sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US",
      },
    });

    expect(credentials.authFailures).toHaveLength(0);
  });

  it("names eBay's error id and message in the failure when the body carries them", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ errors: [{ errorId: 25002, domain: "API_INVENTORY", message: "A user error has occurred.",
        longMessage: "A user error has occurred. Invalid value for aspect Brand.", parameters: [{ name: "aspect", value: "Brand" }] }] }, 400),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 400: 25002 A user error has occurred. Invalid value for aspect Brand. (aspect: Brand)",
      context: { providerErrors: [{ errorId: 25002, domain: "API_INVENTORY", parameters: [{ name: "aspect", value: "Brand" }] }] },
    });
  });

  it.each([
    ["no catalog weight", null],
    ["a zero weight", 0],
    ["a negative weight", -5],
    ["a weight that is not a number", Number.NaN],
    ["an infinite weight", Number.POSITIVE_INFINITY],
  ])("fails before calling eBay when the persisted listing intent has %s", async (_case, weightGrams) => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
      weightGrams,
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_PACKAGE_WEIGHT_REQUIRED",
      context: { productVariantId: 101, retryable: false },
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  // Catalog weights keep fractions of a gram (numeric(10,2) since migration
  // 185), so 1 lb is stored as 453.59 g. eBay gets whole grams, at least 1.
  it.each([
    [453.59, 454],
    [12.5, 13],
    [12.49, 12],
    [0.4, 1],
    [100, 100],
  ])("sends a catalog weight of %s g to eBay as %s g", async (weightGrams, sentGrams) => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      jsonResponse({ offers: [] }),
      emptyResponse(),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
      weightGrams,
    }))).resolves.toMatchObject({ status: "created", externalOfferId: "offer-101" });

    const inventoryBody = JSON.parse(String(fetcher.calls[1]?.init.body));
    expect(inventoryBody.packageWeightAndSize.weight).toEqual({ value: sentGrams, unit: "GRAM" });
  });

  it("forces an access-token refresh without deleting the grant on an eBay listing API 401", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([jsonResponse({ errors: [{ message: "Invalid token" }] }, 401)]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" });

    expect(credentials.authFailures).toEqual([
      expect.objectContaining({
        status: "refresh_failed",
        statusCode: 401,
        retryable: true,
        invalidateAccessToken: true,
      }),
    ]);
  });

  it("fails before any eBay listing mutation when the selected fulfillment policy is incompatible", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const provider = new EbayDropshipListingPushProvider(
      credentials,
      fetcher.fetch,
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
      {
        evaluateForStoreConnection: async () => incompatiblePreflight(),
        evaluateWithAccessToken: async () => incompatiblePreflight(),
      },
      managedLocationProvider(),
    );

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      context: {
        fulfillmentPolicyId: "fulfillment-policy",
        issues: [{ code: "handling_time_too_short" }],
        retryable: false,
      },
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("blocks before any listing mutation when setup does not reference the managed warehouse", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const compatiblePreflight = {
      compatible: true,
      fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash",
      originWarehouseId: 1,
      issues: [],
    } as const;
    const provider = new EbayDropshipListingPushProvider(
      credentials,
      fetcher.fetch,
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
      {
        evaluateForStoreConnection: async () => compatiblePreflight,
        evaluateWithAccessToken: async () => compatiblePreflight,
      },
      managedLocationProvider("cardshellz-dropship-wh-2"),
    );

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
      context: {
        storeConnectionId: 22,
        originWarehouseId: 1,
        retryable: false,
      },
    });
    expect(fetcher.calls).toHaveLength(0);
  });
});

function createEbayProvider(
  credentials: DropshipMarketplaceCredentialRepository,
  fetchFn: typeof fetch,
): EbayDropshipListingPushProvider {
  const compatiblePreflight = {
    compatible: true,
    fulfillmentPolicyId: "fulfillment-policy",
    capabilityEvidenceHash: "capability-hash",
    originWarehouseId: 1,
    issues: [],
  } as const;
  return new EbayDropshipListingPushProvider(
    credentials,
    fetchFn,
    { now: () => new Date("2026-09-01T12:00:00.000Z") },
    {
      evaluateForStoreConnection: async () => compatiblePreflight,
      evaluateWithAccessToken: async () => compatiblePreflight,
    },
    managedLocationProvider(),
    () => quantityAdmission,
  );
}

let quantityAdmission = createAdmittedEbayQuantityTestOwner();

function incompatiblePreflight() {
  return {
    compatible: false,
    fulfillmentPolicyId: "fulfillment-policy",
    capabilityEvidenceHash: "capability-hash",
    originWarehouseId: 1,
    issues: [{
      code: "handling_time_too_short",
      message: "Policy handling time is too short.",
    }],
  };
}

function managedLocationProvider(
  merchantLocationKey = "cardshellz-dropship-wh-1",
) {
  return {
    ensureForStoreConnection: async () => ({
      merchantLocationKey,
      name: "Card Shellz Dropship - LEON",
      originWarehouseId: 1,
      action: "unchanged" as const,
    }),
    ensureWithAccessToken: async () => ({
      merchantLocationKey,
      name: "Card Shellz Dropship - LEON",
      originWarehouseId: 1,
      action: "unchanged" as const,
    }),
  };
}

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  authFailures: DropshipMarketplaceStoreAuthFailureInput[] = [];

  constructor(private credential: DropshipMarketplaceStoreCredentials) {}

  async loadForStoreConnection(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }

  async replaceTokens(input: Parameters<DropshipMarketplaceCredentialRepository["replaceTokens"]>[0]): Promise<DropshipMarketplaceStoreCredentials> {
    this.credential = {
      ...this.credential,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? this.credential.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    };
    return this.credential;
  }

  async recordAuthFailure(
    input: DropshipMarketplaceStoreAuthFailureInput,
  ): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
    this.authFailures.push(input);
    return {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      previousStatus: "connected",
      status: input.status,
      transitioned: true,
    };
  }
}

class FakeFetch {
  calls: Array<{ url: string; init: RequestInit }> = [];

  constructor(private responses: Response[]) {}

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(url), init: init ?? {} });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No fake response for ${String(url)}`);
    }
    return response;
  };
}

function makeRequest(input: {
  platform: "shopify" | "ebay";
  listingMode?: "draft_first" | "live";
  marketplaceConfig?: Record<string, unknown>;
  weightGrams?: number | null;
  marketplaceCategoryId?: string | null;
  storeCategoryNames?: string[];
  mpn?: string | null;
  itemSpecifics?: Record<string, unknown> | null;
}): DropshipMarketplaceListingPushRequest {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    jobId: 30,
    jobItemId: 40,
    listingId: 50,
    productVariantId: 101,
    platform: input.platform,
    existingExternalListingId: null,
    existingExternalOfferId: null,
    idempotencyKey: "push-item-101",
    listingIntent: {
      platform: input.platform,
      listingMode: input.listingMode ?? "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      productVariantId: 101,
      sku: "SKU-101",
      title: "Toploader",
      description: "Rigid card protection.",
      category: "Protectors",
      marketplaceCategoryId: input.marketplaceCategoryId === undefined
        ? (input.platform === "ebay" ? "183438" : null)
        : input.marketplaceCategoryId,
      marketplaceCategoryName: input.platform === "ebay"
        ? "Card Toploaders & Holders"
        : null,
      storeCategoryNames: input.storeCategoryNames ?? [],
      brand: "Card Shellz",
      gtin: "000000000101",
      mpn: input.mpn === undefined ? "TL35" : input.mpn,
      condition: "new",
      itemSpecifics: input.itemSpecifics === undefined ? { Size: ["35pt"] } : input.itemSpecifics,
      imageUrls: ["https://cdn.example.test/toploader.jpg"],
      weightGrams: input.weightGrams === undefined ? 100 : input.weightGrams,
      priceCents: 1299,
      quantity: 4,
      marketplaceConfig: input.marketplaceConfig ?? {},
    },
  };
}

function makeGroupedRebuildDraft() {
  const inventoryItem = (sku: string) => ({
    sku,
    payload: {
      product: {
        title: "Catalog group",
        description: "Catalog group",
        imageUrls: ["https://cdn.example.test/catalog.jpg"],
      },
      condition: "NEW" as const,
      availability: { shipToLocationAvailability: { quantity: 1 } },
    },
  });
  const offer = (sku: string, variantId: number) => ({
    sku,
    variantId,
    payload: {
      sku,
      marketplaceId: "EBAY_US" as const,
      format: "FIXED_PRICE" as const,
      availableQuantity: 1,
      categoryId: "183454",
      listingPolicies: {
        paymentPolicyId: "payment-policy",
        returnPolicyId: "return-policy",
        fulfillmentPolicyId: "fulfillment-policy",
      },
      merchantLocationKey: "vendor-location",
      pricingSummary: { price: { value: "12.99", currency: "USD" } },
    },
  });
  return {
    productId: 501,
    marketplaceId: "EBAY_US",
    inventoryItems: [inventoryItem("CATALOG-KEEP"), inventoryItem("CATALOG-NEW")],
    offers: [offer("CATALOG-KEEP", 5011), offer("CATALOG-NEW", 5012)],
    itemGroup: {
      groupKey: "CATALOG-GROUP",
      payload: {
        aspects: {},
        description: "Catalog group",
        imageUrls: ["https://cdn.example.test/catalog.jpg"],
        title: "Catalog group",
        variantSKUs: ["CATALOG-KEEP", "CATALOG-NEW"],
        variesBy: { specifications: [] },
      },
    },
    publishMode: "publish" as const,
    hasExistingExternalIds: false,
  };
}
function shopifyCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    status: "connected",
    shopDomain: "vendor-shop.myshopify.com",
    externalAccountId: "vendor-shop.myshopify.com",
    externalDisplayName: "Vendor Shop",
    config: {},
    accessToken: "shopify-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenRef: null,
    refreshTokenExpiresAt: null,
  };
}

function ebayCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    providerEnvironment: "production",
    externalAccountIdentityScheme: "ebay_user_id",
    externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"),
    externalDisplayName: "seller-1",
    config: {},
    accessToken: "ebay-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: new Date("2099-05-01T21:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
  };
}

function ebayMarketplaceConfig(): Record<string, unknown> {
  return {
    marketplaceId: "EBAY_US",
    merchantLocationKey: "cardshellz-dropship-wh-1",
    businessPolicies: {
      paymentPolicyId: "payment-policy",
      returnPolicyId: "return-policy",
      fulfillmentPolicyId: "fulfillment-policy",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(): Response {
  return new Response(null, { status: 204 });
}
