import { describe, expect, it } from "vitest";
import type {
  DropshipMarketplaceListingPushRequest,
} from "../../application/dropship-marketplace-listing-push-provider";
import { ShopifyDropshipListingPushProvider } from "../../infrastructure/dropship-shopify-listing-push.provider";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

describe("dropship marketplace listing push providers", () => {
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
    expect(fetcher.calls[3]?.url).toContain("/sell/inventory/v1/offer/offer-101/publish");
  });

  it("creates an authenticated eBay replacement lifecycle client for a Dropship store", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
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
      emptyResponse(),
      emptyResponse(),
      jsonResponse({ offers: [{ offerId: "offer-keep", status: "UNPUBLISHED" }] }),
      jsonResponse({ offers: [{ offerId: "offer-new", status: "UNPUBLISHED" }] }),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
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
      "GET", "GET", "GET", "POST", "DELETE",
      "GET", "GET", "PUT", "PUT", "PUT", "PUT", "PUT", "POST",
    ]);
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
    }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" });

    expect(credentials.authFailures).toHaveLength(0);
  });

  it("fails before calling eBay when the persisted listing intent lacks catalog weight", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
      weightGrams: null,
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_PACKAGE_WEIGHT_REQUIRED",
      context: { productVariantId: 101, retryable: false },
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("still marks the store for reauthorization on an eBay listing API 401", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([jsonResponse({ errors: [{ message: "Invalid token" }] }, 401)]);
    const provider = createEbayProvider(credentials, fetcher.fetch);

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      listingMode: "live",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" });

    expect(credentials.authFailures).toEqual([
      expect.objectContaining({ status: "needs_reauth", statusCode: 401 }),
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
  );
}

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
      mpn: "TL35",
      condition: "new",
      itemSpecifics: { Size: ["35pt"] },
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
