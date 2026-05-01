import { describe, expect, it } from "vitest";
import type {
  DropshipMarketplaceListingPushRequest,
} from "../../application/dropship-marketplace-listing-push-provider";
import { ShopifyDropshipListingPushProvider } from "../../infrastructure/dropship-shopify-listing-push.provider";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import type {
  DropshipMarketplaceCredentialRepository,
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
      emptyResponse(),
      jsonResponse({ offers: [] }),
      jsonResponse({ offerId: "offer-101" }),
      emptyResponse(),
    ]);
    const provider = new EbayDropshipListingPushProvider(credentials, fetcher.fetch);

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
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["PUT", "GET", "POST", "PUT"]);
    const inventoryBody = JSON.parse(String(fetcher.calls[0]?.init.body));
    expect(inventoryBody).toMatchObject({
      product: {
        title: "Toploader",
        imageUrls: ["https://cdn.example.test/toploader.jpg"],
        brand: "Card Shellz",
      },
      availability: {
        shipToLocationAvailability: { quantity: 4 },
      },
    });
    const offerBody = JSON.parse(String(fetcher.calls[2]?.init.body));
    expect(offerBody).toMatchObject({
      marketplaceId: "EBAY_US",
      categoryId: "183454",
      merchantLocationKey: "vendor-location",
      pricingSummary: { price: { value: "12.99", currency: "USD" } },
    });
  });

  it("publishes an eBay offer when listing mode is live", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    const fetcher = new FakeFetch([
      emptyResponse(),
      jsonResponse({ offers: [{ offerId: "offer-101" }] }),
      emptyResponse(),
      jsonResponse({ listingId: "listing-101" }),
    ]);
    const provider = new EbayDropshipListingPushProvider(credentials, fetcher.fetch);

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
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
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
      brand: "Card Shellz",
      gtin: "000000000101",
      mpn: "TL35",
      condition: "new",
      itemSpecifics: { Size: ["35pt"] },
      imageUrls: ["https://cdn.example.test/toploader.jpg"],
      priceCents: 1299,
      quantity: 4,
      marketplaceConfig: input.marketplaceConfig ?? {},
    },
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
    categoryId: "183454",
    merchantLocationKey: "vendor-location",
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
