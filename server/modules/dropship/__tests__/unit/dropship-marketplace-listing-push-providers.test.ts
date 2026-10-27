import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { DropshipEbayStockReadinessGate } from "../../infrastructure/dropship-ebay-stock-readiness.gate";
import type { DropshipEbayStockReadinessResult } from "../../../inventory-planning/quantity-publication";
import { QuantityPublicationAdmissionError } from "../../../inventory-planning/domain/quantity-publication-admission";
import { PostgresDropshipEbayPushPublicationReader, type DropshipEbayPushPublicationReader } from "../../infrastructure/dropship-ebay-push-publication.reader";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { DropshipEbayRegistrationCredentialAdapter } from "../../infrastructure/dropship-ebay-registration-credential-adapter";
import { createAdmittedEbayQuantityTestOwner } from "../../../channels/__tests__/fixtures/quantity-publication-admission";
import type {
  DropshipMarketplaceListingPushRequest,
  DropshipMarketplaceListingPushSent,
} from "../../application/dropship-marketplace-listing-push-provider";
import { sha256Hex, observedOfferGuardFields } from "../../domain/marketplace-listing-observation";
import type { MarketplacePushGuard, MarketplacePushPassthrough } from "../../domain/marketplace-sync-decision";
import { ShopifyDropshipListingPushProvider } from "../../infrastructure/dropship-shopify-listing-push.provider";
import { EbayDropshipListingPushProvider, type EbayDropshipListingPushProviderOptions } from "../../infrastructure/dropship-ebay-listing-push.provider";
import { QuantityProviderEvidenceCollector, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";
import { DropshipError } from "../../domain/errors";
import type { DropshipEbayFulfillmentPolicyPreflight } from "../../application/dropship-ebay-fulfillment-policy-guard";

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
    expect(fetcher.calls).toHaveLength(4);
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

    const inventoryBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "PUT" && call.url.includes("/inventory_item/"))?.init.body));
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

    const inventoryBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "PUT" && call.url.includes("/inventory_item/"))?.init.body));
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
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "POST", "PUT", "GET"]);
    expect(quantityAdmission.item.mock.calls.map(([sku]) => sku)).toEqual(["SKU-101", "SKU-101", "SKU-101"]);
    const inventoryBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "PUT" && call.url.includes("/inventory_item/"))?.init.body));
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
    const offerBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "POST" && call.url.endsWith("/offer"))?.init.body));
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
      jsonResponse({ offers: [{ offerId: "offer-101", sku: "SKU-101", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "UNPUBLISHED" }] }), emptyResponse(), emptyResponse(),
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

    const offerBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "POST" && call.url.endsWith("/offer"))?.init.body));
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
      jsonResponse({ offers: [{ offerId: "offer-101", sku: "SKU-101", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "UNPUBLISHED" }] }),
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
    expect(fetcher.calls[5]?.url).toContain("/sell/inventory/v1/offer/offer-101");
    expect(fetcher.calls[5]?.init.method).toBe("GET");
    expect(fetcher.calls[6]?.url).toContain("/sell/inventory/v1/offer/offer-101/publish");
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
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "PUT", "GET", "POST", "GET"]);
  });

  it("adopts a published Dropship offer using the shared observer and exact vendor-owned parent product", async () => {
    const credential = ebayCredential();
    const credentials = new FakeCredentialRepository(credential);
    const query = vi.fn(async () => ({ rows: [{ product_id: 20,product_variant_id:101,is_active:true }] }));
    const readCalls: string[] = [];
    const observedOffer = { offerId:"offer-101",sku:"SKU-101",marketplaceId:"EBAY_US",format:"FIXED_PRICE",status:"PUBLISHED",
      listing:{ listingId:"listing-101",listingStatus:"ACTIVE" } };
    const observer = new EbayMarketplaceRegistrationObserver(new DropshipEbayRegistrationCredentialAdapter({
      loadStoreConnection: async () => ({ id:22,vendorId:10,platform:"ebay",status:"connected",marketplaceIds:["EBAY_US"] }),
    }, { loadFreshForStoreConnection: async () => credential }), {
      get: async input => {
        readCalls.push(input.path);
        if (input.path.includes("/identity/")) return { status:200,body:{ userId:"seller-1",username:"seller" } };
        if (input.path.includes("/inventory_item/")) return { status:200,body:{ sku:"SKU-101",groupIds:[] } };
        return { status:200,body:{ total:1,offers:[observedOffer] } };
      },
    });
    const reader = new PostgresDropshipEbayPushPublicationReader({ query } as unknown as Pick<Pool,"query">,observer);
    const fetcher = new FakeFetch([jsonResponse({ offers:[observedOffer] }),emptyResponse(),emptyResponse()]);
    const provider = createEbayProvider(credentials,fetcher.fetch,reader);
    const request = makeRequest({ platform:"ebay",listingMode:"live",marketplaceConfig:ebayMarketplaceConfig() });
    await expect(provider.pushListing(request)).resolves.toMatchObject({ externalListingId:"listing-101",externalOfferId:"offer-101" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pv.product_id"),[50,10,22,101]);
    expect(readCalls).toHaveLength(3);
    expect(fetcher.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "PUT", "GET"]);
    await expect(reader.resolve({ ...request,vendorId:99 },credential,{ listingId:"listing-101",members:[{ variantId:101,sku:"SKU-101",offerId:"offer-101" }] }))
      .rejects.toMatchObject({ code:"DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED" });
    await expect(reader.resolve(request,{ ...credential,externalAccountId:"different-seller" },{ listingId:"listing-101",members:[{ variantId:101,sku:"SKU-101",offerId:"offer-101" }] }))
      .rejects.toMatchObject({ code:"EBAY_SYNC_IDENTITY_CHANGED" });
    const grouped = makeGroupedRebuildDraft();
    const rebuildDraft = { ...grouped,productId:20,itemGroup:null,
      offers:[{ ...grouped.offers[0],variantId:101,sku:"SKU-101",payload:{ ...grouped.offers[0].payload,sku:"SKU-101" } }] };
    await expect(reader.resolveRebuild({ vendorId:10,storeConnectionId:22,draft:rebuildDraft },credential,
      { listingId:"listing-101",members:[{ variantId:101,sku:"SKU-101",offerId:"offer-101" }] })).resolves.toMatchObject({ listingIdentity:{ externalId:"listing-101" } });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("pv.product_id=$3"),[10,22,20,[101]]);
    query.mockResolvedValueOnce({ rows:[] });
    await expect(reader.resolveRebuild({ vendorId:10,storeConnectionId:22,draft:rebuildDraft },credential,
      { listingId:"listing-101",members:[{ variantId:101,sku:"SKU-101",offerId:"offer-101" }] })).rejects.toMatchObject({ code:"DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED" });
  });

  // Production stores provider_user_id (migration 0609's CHECK admits nothing else). With that
  // credential the adoption must reach eBay's identity read, and the shared connector's refusals
  // must reach the worker as DropshipErrors with the right retry class.
  describe("shared connector refusals on a published SKU", () => {
    const observedOffer = { offerId:"offer-101",sku:"SKU-101",marketplaceId:"EBAY_US",format:"FIXED_PRICE",status:"PUBLISHED",
      listing:{ listingId:"listing-101",listingStatus:"ACTIVE" } };
    function adoptionProvider(identity: { status: number; body: unknown }, writes: Response[] = [],
      credentials: FakeCredentialRepository = new FakeCredentialRepository(ebayCredential())) {
      const credential = ebayCredential();
      const readCalls: string[] = [];
      const observer = new EbayMarketplaceRegistrationObserver(new DropshipEbayRegistrationCredentialAdapter({
        loadStoreConnection: async () => ({ id:22,vendorId:10,platform:"ebay",status:"connected",marketplaceIds:["EBAY_US"] }),
      }, { loadFreshForStoreConnection: async () => credential }), {
        get: async input => {
          readCalls.push(input.path);
          if (input.path.includes("/identity/")) return identity;
          if (input.path.includes("/inventory_item/")) return { status:200,body:{ sku:"SKU-101",groupIds:[] } };
          return { status:200,body:{ total:1,offers:[observedOffer] } };
        },
      });
      const query = vi.fn(async () => ({ rows: [{ product_id: 20,product_variant_id:101,is_active:true }] }));
      const reader = new PostgresDropshipEbayPushPublicationReader({ query } as unknown as Pick<Pool,"query">,observer);
      const fetcher = new FakeFetch([jsonResponse({ offers:[observedOffer] }),...writes]);
      const provider = createEbayProvider(credentials,fetcher.fetch,reader);
      return { provider, fetcher, readCalls, query, credentials };
    }
    const liveRequest = () => makeRequest({ platform:"ebay",listingMode:"live",marketplaceConfig:ebayMarketplaceConfig() });

    function expectOfferDiscoveryOnly(fetcher: FakeFetch): void {
      // Discovery and ownership refusals precede package reads and listing writes.
      expect(fetcher.calls).toEqual([{
        url: "https://api.ebay.com/sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US",
        init: expect.objectContaining({ method: "GET" }),
      }]);
    }

    it("reaches eBay's identity read with the stored provider_user_id credential", async () => {
      const { provider, fetcher, readCalls, query } = adoptionProvider({ status:200,body:{ userId:"seller-1",username:"seller" } },
        [emptyResponse(),emptyResponse()]);
      await expect(provider.pushListing(liveRequest())).resolves.toMatchObject({ externalListingId:"listing-101" });
      expect(query).toHaveBeenCalledTimes(1);
      expect(fetcher.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "PUT", "GET"]);
      expect(readCalls.some(path => path.includes("/identity/"))).toBe(true);
    });

    it("files a published listing owned by a different seller as permanent, before any eBay write", async () => {
      const { provider, fetcher, credentials } = adoptionProvider({ status:200,body:{ userId:"different-seller",username:"other" } });
      const error = await provider.pushListing(liveRequest()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({ code:"EBAY_SYNC_IDENTITY_CHANGED",context:{ retryable:false,source:"ebay_listing_connector" } });
      expectOfferDiscoveryOnly(fetcher);
      expect(credentials.authFailures).toEqual([]);
    });

    it("keeps an eBay 503 on the identity read retryable, before any eBay write", async () => {
      const { provider, fetcher, credentials } = adoptionProvider({ status:503,body:{} });
      await expect(provider.pushListing(liveRequest())).rejects.toMatchObject({
        code:"EBAY_REGISTRATION_READ_FAILED",context:{ retryable:true,source:"ebay_listing_connector" },
      });
      expectOfferDiscoveryOnly(fetcher);
      expect(credentials.authFailures).toEqual([]);
    });

    // The identity read borrows the stored token right after the provider's own GET succeeded
    // with it. A 401 there is the same token rejection the provider records for its own calls
    // (throwListingHttpError): record it so the next attempt refreshes, and keep it retryable.
    it("records an eBay 401 on the identity read as a token rejection and keeps it retryable", async () => {
      const { provider, fetcher, credentials } = adoptionProvider({ status:401,body:{ errors:[{ message:"Invalid token" }] } });
      const error = await provider.pushListing(liveRequest()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({ code:"EBAY_AUTH_REQUIRED",context:{ retryable:true,source:"ebay_listing_connector" } });
      expectOfferDiscoveryOnly(fetcher);
      expect(credentials.authFailures).toEqual([{
        vendorId:10,storeConnectionId:22,platform:"ebay",
        expectedCredential:{ accessTokenRef:"access-ref",refreshTokenRef:"refresh-ref" },
        status:"refresh_failed",failureCode:"EBAY_AUTH_REQUIRED",message:(error as DropshipError).message,
        retryable:true,statusCode:401,invalidateAccessToken:true,now:new Date("2026-09-01T12:00:00.000Z"),
      }]);
    });

    it("surfaces a failed token-rejection record instead of the 401, as the provider's own HTTP path does", async () => {
      const changed = new DropshipError("DROPSHIP_CREDENTIAL_CHANGED","Store authorization changed while the request was in flight.",
        { retryable:true });
      const credentials = new FakeCredentialRepository(ebayCredential());
      credentials.recordAuthFailure = async (input) => { credentials.authFailures.push(input); throw changed; };
      const { provider, fetcher } = adoptionProvider({ status:401,body:{} },[],credentials);
      await expect(provider.pushListing(liveRequest())).rejects.toBe(changed);
      expectOfferDiscoveryOnly(fetcher);
      expect(credentials.authFailures).toHaveLength(1);
    });

    it("files an eBay 403 on the identity read as permanent without touching the token", async () => {
      const { provider, fetcher, credentials } = adoptionProvider({ status:403,body:{} });
      await expect(provider.pushListing(liveRequest())).rejects.toMatchObject({
        code:"EBAY_PROVIDER_ACCESS_DENIED",context:{ retryable:false,source:"ebay_listing_connector" },
      });
      expectOfferDiscoveryOnly(fetcher);
      expect(credentials.authFailures).toEqual([]);
    });

    it("files two eBay offers for one SKU as a permanent mapping refusal before any write", async () => {
      const second = { ...observedOffer,offerId:"offer-202" };
      const fetcher = new FakeFetch([jsonResponse({ offers:[observedOffer,second] })]);
      const provider = createEbayProvider(new FakeCredentialRepository(ebayCredential()),fetcher.fetch);
      await expect(provider.pushListing(liveRequest())).rejects.toMatchObject({
        code:"EBAY_SYNC_MAPPING_INVALID",context:{ retryable:false,source:"ebay_listing_connector" },
      });
      expectOfferDiscoveryOnly(fetcher);
    });
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
      jsonResponse({ offers: [{ offerId: "offer-keep", sku: "CATALOG-KEEP", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "UNPUBLISHED" }] }),
      jsonResponse({ offers: [{ offerId: "offer-new", sku: "CATALOG-NEW", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "UNPUBLISHED" }] }),
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
      "GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET", "POST", "GET", "GET", "DELETE",
      "GET", "GET", "GET", "GET", "PUT", "PUT", "PUT", "PUT", "PUT", "GET", "GET", "POST",
    ]);
    // Publishing the rebuilt group cannot use the unchanged-group maintenance
    // exception: every member still requires canonical quantity admission.
    expect(quantityAdmission.group).toHaveBeenLastCalledWith("CATALOG-GROUP", ["CATALOG-KEEP", "CATALOG-NEW"], expect.any(Function), undefined);
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
      "GET /sell/inventory/v1/inventory_item/SKU-101",
      "GET /sell/inventory/v1/inventory_item/SKU-101",
      "PUT /sell/inventory/v1/inventory_item/SKU-101",
      "POST /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/offer/offer-201",
      "GET /sell/inventory/v1/offer/offer-201",
      "POST /sell/inventory/v1/offer/offer-201/publish",
      "GET /sell/inventory/v1/inventory_item/SKU-101",
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
    expect(fetcher.calls).toHaveLength(4);
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

  // The shared builder preserves measured fractions instead of inventing a
  // whole-gram minimum for this second consumer of the same connector.
  it.each([453.59, 12.5, 12.49, 0.4, 100])("preserves a catalog weight of %s g on eBay", async (weightGrams) => {
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

    const inventoryBody = JSON.parse(String(fetcher.calls.find(call => call.init.method === "PUT" && call.url.includes("/inventory_item/"))?.init.body));
    expect(inventoryBody.packageWeightAndSize.weight).toEqual({ value: weightGrams, unit: "GRAM" });
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
      undefined,
      undefined,
      { stockReadiness: legacyStockReadiness() },
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
    const compatiblePreflight: DropshipEbayFulfillmentPolicyPreflight = {
      compatible: true,
      fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash",
      originWarehouseId: 1,
      issues: [],
    };
    const provider = new EbayDropshipListingPushProvider(
      credentials,
      fetcher.fetch,
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
      {
        evaluateForStoreConnection: async () => compatiblePreflight,
        evaluateWithAccessToken: async () => compatiblePreflight,
      },
      managedLocationProvider("cardshellz-dropship-wh-2"),
      undefined,
      undefined,
      { stockReadiness: legacyStockReadiness() },
    );

    await expect(provider.pushListing(makeRequest({
      platform: "ebay",
      marketplaceConfig: ebayMarketplaceConfig(),
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
      // The message reaches the vendor's push-failure email as is, so it names
      // the Listing settings action (W10, the [Update now] under Shipping policy)
      // instead of asking for a full re-save (Listing settings PR 12 verify VC1).
      message: "Card Shellz needs to update where your eBay listings ship from. Open Listing settings, choose Update now under Shipping policy, then queue the listing again.",
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
  existingPublication?: DropshipEbayPushPublicationReader,
): EbayDropshipListingPushProvider {
  const compatiblePreflight: DropshipEbayFulfillmentPolicyPreflight = {
    compatible: true,
    fulfillmentPolicyId: "fulfillment-policy",
    capabilityEvidenceHash: "capability-hash",
    originWarehouseId: 1,
    issues: [],
  };
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
    existingPublication,
    { stockReadiness: legacyStockReadiness(), sleep: async () => {} },
  );
}

/** Legacy inventory authority: the push links nothing and keeps today's behavior. */
function legacyStockReadiness() {
  return {
    begin: async () => ({ authority: "legacy" as const, mustLink: false }),
    ensureLinked: async () => { throw new Error("A legacy push never links stock."); },
  };
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
  private inventoryItems = new Map<string, Record<string, unknown>>();

  constructor(private responses: Response[]) {}

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(url), init: init ?? {} });
    const path = new URL(String(url)).pathname;
    const inventorySku = path.startsWith("/sell/inventory/v1/inventory_item/") ? decodeURIComponent(path.split("/").at(-1)!) : null;
    if (inventorySku && init?.method === "GET") {
      const item = this.inventoryItems.get(inventorySku);
      return item ? jsonResponse(item) : new Response(JSON.stringify({ errors: [{ errorId: 25710 }] }), { status: 404 });
    }
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No fake response for ${String(url)}`);
    }
    if (inventorySku && init?.method === "PUT" && response.ok) {
      this.inventoryItems.set(inventorySku, { ...JSON.parse(String(init.body)), sku: inventorySku });
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
    // Migration 0609's columns, as a Shopify row without a verified stable identity holds them.
    providerEnvironment: null,
    externalAccountIdentityScheme: null,
    externalAccountVerifiedAt: null,
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
    externalAccountIdentityScheme: "provider_user_id",
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

// Fix PR 2a-2 (plan F2 2.1, 2.9.1, 9.1): the automatic stock link inside the
// connector, and the bounded retry of a busy exact SKU scope.
describe("eBay listing push stock link (Fix PR 2a-2)", () => {
  beforeEach(() => { quantityAdmission = createAdmittedEbayQuantityTestOwner(); });

  /** The real gate over DI fakes: canonical authority, an owned listing, scripted inventory outcomes. */
  function canonicalGate(ensure: () => Promise<DropshipEbayStockReadinessResult>) {
    const ensureCalls: number[] = [];
    let fetcherCallsAtLink = -1;
    const gate = new DropshipEbayStockReadinessGate({
      readAuthority: async () => "canonical",
      ensure: async () => { ensureCalls.push(fetcherCallsAtLink); return ensure(); },
      database: { query: async () => ({ rows: [{ product_id: 20, requested_by: "member-7" }] }) } as unknown as Pick<Pool, "query">,
      clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
      sleep: async () => {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    return { gate, ensureCalls, markFetcher: (count: number) => { fetcherCallsAtLink = count; } };
  }
  const linked: DropshipEbayStockReadinessResult = { status: "ready", commandKey: "5e0f7f3c-2a4b-5c6d-8e9f-0a1b2c3d4e5f",
    publicationTargetId: 7, linkedProductVariantIds: [101], alreadyLinked: false,
    mappingActions: [{ productVariantId: 101, mappingAction: "create" }], preparation: null, fenceHoldMs: 12 };
  const noDestination: DropshipEbayStockReadinessResult = { status: "blocked", commandKey: "5e0f7f3c-2a4b-5c6d-8e9f-0a1b2c3d4e5f",
    publicationTargetId: null, targetCount: 0, blockers: [{ code: "STOCK_LISTING_TARGET_MISMATCH",
      message: "This Dropship eBay store account has no live Card Shellz stock destination.", action: "configure_inventory", productVariantId: null }] };
  const provider = (fetcher: FakeFetch, stockReadiness: EbayDropshipListingPushProviderOptions["stockReadiness"],
    sleep: (ms: number) => Promise<void> = async () => {}) => {
    const preflight: DropshipEbayFulfillmentPolicyPreflight = { compatible: true, fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash", originWarehouseId: 1, issues: [] };
    return new EbayDropshipListingPushProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch,
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
      { evaluateForStoreConnection: async () => preflight, evaluateWithAccessToken: async () => preflight },
      managedLocationProvider(), () => quantityAdmission, undefined, { stockReadiness, sleep });
  };
  const live = (patch: { quantity?: number; listingMode?: "live" | "draft_first"; inventoryMode?: "managed_quantity_sync" | "manual_quantity" } = {}) => {
    const base = makeRequest({ platform: "ebay", listingMode: patch.listingMode ?? "live", marketplaceConfig: ebayMarketplaceConfig() });
    return { ...base, listingIntent: { ...base.listingIntent, quantity: patch.quantity ?? base.listingIntent.quantity,
      inventoryMode: patch.inventoryMode ?? base.listingIntent.inventoryMode } };
  };
  const mutatingInventoryOrOfferCalls = (fetcher: FakeFetch) => fetcher.calls.filter(call => call.init.method !== "GET"
    && /\/sell\/inventory\/v1\/(inventory_item|offer)/.test(call.url));
  const newListingResponses = () => [
    jsonResponse({ offers: [] }), emptyResponse(), jsonResponse({ offerId: "offer-101" }), emptyResponse(),
    jsonResponse({ offerId: "offer-101", sku: "SKU-101", marketplaceId: "EBAY_US" }), jsonResponse({ listingId: "listing-101" }),
  ];

  it("links stock once, after the connector's offer lookup and before its first inventory-item or offer write", async () => {
    const fetcher = new FakeFetch(newListingResponses());
    const { gate, ensureCalls, markFetcher } = canonicalGate(async () => linked);
    const ensureLinked = gate.ensureLinked.bind(gate);
    gate.ensureLinked = async (input) => { markFetcher(fetcher.calls.length); return ensureLinked(input); };

    await expect(provider(fetcher, gate).pushListing(live())).resolves.toMatchObject({ externalListingId: "listing-101", externalOfferId: "offer-101" });

    expect(ensureCalls).toEqual([3]);
    expect(fetcher.calls.slice(0, ensureCalls[0]).map(call => {
      const url = new URL(call.url);
      return `${call.init.method} ${url.pathname}${url.search}`;
    })).toEqual([
      "GET /sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US",
      "GET /sell/inventory/v1/inventory_item/SKU-101",
      "GET /sell/inventory/v1/inventory_item/SKU-101",
    ]);
    expect(fetcher.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "POST", "PUT", "GET", "POST", "GET"]);
  });

  it.each([
    ["draft_first", { listingMode: "draft_first" as const, quantity: 0 }],
    ["manual quantity", { inventoryMode: "manual_quantity" as const, quantity: 0 }],
  ])("does not link a %s push (zero quantity, so it is not refused either)", async (_name, patch) => {
    const fetcher = new FakeFetch("listingMode" in patch && patch.listingMode === "draft_first"
      ? [jsonResponse({ offers: [] }), emptyResponse(), jsonResponse({ offerId: "offer-101" }), emptyResponse()]
      : newListingResponses());
    const { gate, ensureCalls } = canonicalGate(async () => linked);
    await provider(fetcher, gate).pushListing(live(patch));
    expect(ensureCalls).toEqual([]);
  });

  // Review TW-1: the adoption check of an automatic re-queue runs even when the push needs no stock link.
  it("checks an automatic re-queue of a push that needs no stock link at the same hook, without linking", async () => {
    const fetcher = new FakeFetch([jsonResponse({ offers: [] }), emptyResponse(), jsonResponse({ offerId: "offer-101" }), emptyResponse()]);
    const calls: Array<{ linkStock?: boolean; fetcherCalls: number }> = [];
    const port = {
      begin: async () => ({ authority: "canonical" as const, mustLink: false }),
      ensureLinked: async (input: { linkStock?: boolean }) => { calls.push({ linkStock: input.linkStock, fetcherCalls: fetcher.calls.length }); },
    };
    await provider(fetcher, port).pushListing({ ...live({ listingMode: "draft_first", quantity: 0 }), automaticRetry: true });
    expect(calls).toEqual([{ linkStock: false, fetcherCalls: 3 }]);
    const plain = new FakeFetch([jsonResponse({ offers: [] }), emptyResponse(), jsonResponse({ offerId: "offer-101" }), emptyResponse()]);
    await provider(plain, port).pushListing(live({ listingMode: "draft_first", quantity: 0 }));
    expect(calls).toHaveLength(1);
  });

  it("stops a zero-quantity live push the link refuses before any inventory-item, offer or reducing write", async () => {
    const fetcher = new FakeFetch(newListingResponses());
    const { gate } = canonicalGate(async () => noDestination);
    await expect(provider(fetcher, gate).pushListing(live({ quantity: 0 }))).rejects.toMatchObject({
      code: "DROPSHIP_STOCK_DESTINATION_NOT_READY", context: { retryable: false, needsOperator: true, targetCount: 0 } });
    expect(mutatingInventoryOrOfferCalls(fetcher)).toEqual([]);
    expect(fetcher.calls).toHaveLength(3);
    expect(quantityAdmission.reducing).not.toHaveBeenCalled();
    expect(quantityAdmission.item).not.toHaveBeenCalled();
  });

  it("refuses every eBay push from a provider built without the stock port, before any eBay call", async () => {
    const fetcher = new FakeFetch([]);
    const bare = new EbayDropshipListingPushProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch);
    await expect(bare.pushListing(live())).rejects.toMatchObject({ code: "DROPSHIP_STOCK_READINESS_REQUIRED",
      message: "Card Shellz couldn't check this item's stock link.",
      context: { retryable: false, needsOperator: true, classification: "fatal" } });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("wires the gate in the only root that pushes listings; the replacement root never calls pushListing", () => {
    const providers = readFileSync(resolve(__dirname, "../../infrastructure/dropship-marketplace-listing-push.providers.ts"), "utf8");
    // Review TW-9 (plan 2.6): the gate reads the provider's own injected clock, not a second one.
    expect(providers).toMatch(/const clock = \{ now: \(\) => new Date\(\) \};/);
    expect(providers).toMatch(/new EbayDropshipListingPushProvider\(\s*credentials,\s*fetch,\s*clock,/);
    expect(providers).toMatch(/stockReadiness: createDropshipEbayStockReadinessGate\(\{ pool, clock, sleep \}\)/);
    const replacement = readFileSync(resolve(__dirname, "../../../../marketplace-listing-replacement.composition.ts"), "utf8");
    expect(replacement).toContain("new EbayDropshipListingPushProvider(");
    expect(replacement).not.toMatch(/\.pushListing\(/);
    expect(replacement).toContain("createReplacementLifecycleClient(");
  });

  it("retries an admitted write refused PUBLICATION_SCOPE_BUSY with the bounded backoff", async () => {
    const fetcher = new FakeFetch(newListingResponses());
    let busy = 2;
    quantityAdmission.item.mockImplementation(async (_sku, work) => {
      if (busy-- > 0) throw new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "Another exact-scope publisher is running.");
      return work(null);
    });
    const sleeps: number[] = [];
    const { gate } = canonicalGate(async () => linked);
    await expect(provider(fetcher, gate, async ms => { sleeps.push(ms); }).pushListing(live())).resolves.toMatchObject({ externalOfferId: "offer-101" });
    expect(sleeps).toEqual([500, 1_500]);
    // The refused request reached no provider: one inventory-item PUT was sent.
    expect(fetcher.calls.filter(call => call.init.method === "PUT" && call.url.includes("/inventory_item/"))).toHaveLength(1);
  });

  it("rethrows PUBLICATION_SCOPE_BUSY unchanged after the last bounded retry", async () => {
    const fetcher = new FakeFetch(newListingResponses());
    quantityAdmission.item.mockImplementation(async () => {
      throw new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "Another exact-scope publisher is running.");
    });
    const sleeps: number[] = [];
    const { gate } = canonicalGate(async () => linked);
    await expect(provider(fetcher, gate, async ms => { sleeps.push(ms); }).pushListing(live()))
      .rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY", name: "QuantityPublicationAdmissionError" });
    expect(sleeps).toEqual([500, 1_500, 3_000]);
    expect(quantityAdmission.item).toHaveBeenCalledTimes(4);
    expect(mutatingInventoryOrOfferCalls(fetcher)).toEqual([]);
  });

  it("never repeats a multi-row bulk quantity request: an earlier row may already be on eBay", async () => {
    const fetcher = new FakeFetch([jsonResponse({ responses: [{ sku: "SKU-101", offerId: "offer-101", statusCode: 200 }] })]);
    let calls = 0;
    quantityAdmission.item.mockImplementation(async (_sku, work) => {
      calls += 1;
      if (calls > 1) throw new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "Another exact-scope publisher is running.");
      return work(null);
    });
    const sleeps: number[] = [];
    const session = await provider(fetcher, undefined, async ms => { sleeps.push(ms); })
      .createReplacementLifecycleClient({ vendorId: 10, storeConnectionId: 22, marketplaceConfig: ebayMarketplaceConfig() });
    await expect(session.client.bulkUpdatePriceQuantity({ requests: [
      { sku: "SKU-101", shipToLocationAvailability: { quantity: 3 }, offers: [{ offerId: "offer-101", availableQuantity: 3 }] },
      { sku: "SKU-102", shipToLocationAvailability: { quantity: 4 }, offers: [{ offerId: "offer-102", availableQuantity: 4 }] },
    ] })).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY", name: "QuantityPublicationAdmissionError" });
    expect(sleeps).toEqual([]);
    expect(quantityAdmission.item).toHaveBeenCalledTimes(2);
    // The first row reached eBay once and was not sent again.
    expect(fetcher.calls.filter(call => call.url.endsWith("/sell/inventory/v1/bulk_update_price_quantity"))).toHaveLength(1);
  });
});

// eBay sync-back's push-time rule in the provider (plan v4 §5 steps 4-6, owner rules 2 and 4).
describe("eBay listing push: sync-back pre-write guard, attempt and passthrough", () => {
  beforeEach(() => { quantityAdmission = createAdmittedEbayQuantityTestOwner(); });

  const VENDOR_TITLE = "Vendor's own eBay title";
  const VENDOR_DESCRIPTION = "<p>Vendor's own description</p>";
  const BEST_OFFER = { bestOfferEnabled: true, autoAcceptPrice: { value: "12.00", currency: "USD" } };
  /** The offer eBay shows for the SKU, as both the pre-read and the connector's own lookup see it. */
  const liveOffer = (patch: Record<string, unknown> = {}) => ({ offerId: "offer-101", sku: "SKU-101", marketplaceId: "EBAY_US",
    format: "FIXED_PRICE", status: "UNPUBLISHED", availableQuantity: 4, listingDescription: VENDOR_DESCRIPTION,
    pricingSummary: { price: { value: "12.99", currency: "USD" } },
    listingPolicies: { fulfillmentPolicyId: "fulfillment-policy", returnPolicyId: "return-policy", paymentPolicyId: "payment-policy",
      bestOfferTerms: BEST_OFFER }, ...patch });
  const guardOf = (offer: Record<string, unknown>): MarketplacePushGuard => {
    const fields = observedOfferGuardFields(offer)!;
    return { offerId: fields.offerId, listingId: fields.listingId, priceCents: fields.priceCents!, currency: fields.currency,
      ...fields.policies, bestOfferTermsHash: fields.bestOfferTermsHash, offerDescriptionHash: fields.offerDescriptionHash,
      availableQuantity: fields.availableQuantity };
  };
  function request(sync: { passthrough: MarketplacePushPassthrough; guard?: MarketplacePushGuard; liveFulfillmentPolicyId?: string | null },
    attempts: Array<{ sent: DropshipMarketplaceListingPushSent; fetcherCalls: number }>, fetcher: FakeFetch): DropshipMarketplaceListingPushRequest {
    const base = makeRequest({ platform: "ebay", marketplaceConfig: ebayMarketplaceConfig() });
    return { ...base, existingExternalOfferId: "offer-101", existingExternalListingId: "offer-101", marketplaceSync: {
      guard: sync.guard ?? guardOf(liveOffer()), passthrough: sync.passthrough, liveFulfillmentPolicyId: sync.liveFulfillmentPolicyId ?? null,
      beforeFirstWrite: async (sent) => { attempts.push({ sent, fetcherCalls: fetcher.calls.length }); } } };
  }
  const writes = (fetcher: FakeFetch) => fetcher.calls.filter((call) => call.init.method !== "GET");
  const body = (fetcher: FakeFetch, suffix: string) => JSON.parse(String(fetcher.calls.find((call) => call.init.method === "PUT"
    && call.url.endsWith(suffix))!.init.body));

  /** Card Shellz's own last title and description fingerprints, which a passed-through field carries forward (review OR-1). */
  const CARRIED = { title: sha256Hex("Card Shellz title sent before"), description: sha256Hex("<p>Card Shellz words sent before</p>") };
  const NONE_CARRIED = { title: null, description: null };

  it("FF-14: sends the vendor's own title and description back exactly as eBay showed them, with their Best Offer terms, after recording the attempt", async () => {
    const fetcher = new FakeFetch([jsonResponse({ offers: [liveOffer()] }), emptyResponse(), emptyResponse()]);
    const attempts: Array<{ sent: DropshipMarketplaceListingPushSent; fetcherCalls: number }> = [];

    const result = await createEbayProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch).pushListing(
      request({ passthrough: { title: VENDOR_TITLE, description: VENDOR_DESCRIPTION, bestOfferTerms: BEST_OFFER, carriedFingerprints: CARRIED } },
        attempts, fetcher));

    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET", "GET", "GET", "PUT", "PUT", "GET"]);
    expect(body(fetcher, "/inventory_item/SKU-101").product).toMatchObject({ title: VENDOR_TITLE, description: VENDOR_DESCRIPTION });
    const offer = body(fetcher, "/offer/offer-101");
    expect(offer.listingDescription).toBe(VENDOR_DESCRIPTION);
    expect(offer.listingPolicies).toEqual({ fulfillmentPolicyId: "fulfillment-policy", returnPolicyId: "return-policy",
      paymentPolicyId: "payment-policy", bestOfferTerms: BEST_OFFER });
    // listing_push_attempted (SB3): once, after the connector's lookup and before its first write, with what the push writes.
    // Review OR-1: the vendor's text is never recorded as Card Shellz's; the carried fingerprints stay Card Shellz's own.
    const sent = { priceCents: 1299, currency: "USD", sku: "SKU-101", fulfillmentPolicyId: "fulfillment-policy",
      returnPolicyId: "return-policy", paymentPolicyId: "payment-policy", titleHash: CARRIED.title, descriptionHash: CARRIED.description };
    expect(attempts).toEqual([{ sent, fetcherCalls: 3 }]);
    expect(result.sent).toEqual(sent);
  });

  it("sends Card Shellz's current title and description, as today, when eBay shows what Card Shellz last sent", async () => {
    const fetcher = new FakeFetch([jsonResponse({ offers: [liveOffer()] }), emptyResponse(), emptyResponse()]);
    const attempts: Array<{ sent: DropshipMarketplaceListingPushSent; fetcherCalls: number }> = [];
    const result = await createEbayProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch).pushListing(
      request({ passthrough: { title: null, description: null, bestOfferTerms: null, carriedFingerprints: NONE_CARRIED } }, attempts, fetcher));
    expect(body(fetcher, "/inventory_item/SKU-101").product).toMatchObject({ title: "Toploader", description: "Rigid card protection." });
    // Review OR-1: what this push actually wrote (the refreshed intent's text) is what it records as sent.
    expect(attempts[0]!.sent).toMatchObject({ titleHash: sha256Hex("Toploader"), descriptionHash: sha256Hex("Rigid card protection.") });
    expect(result.sent).toMatchObject({ titleHash: sha256Hex("Toploader"), descriptionHash: sha256Hex("Rigid card protection.") });
    const offer = body(fetcher, "/offer/offer-101");
    expect(offer.listingDescription).toBe("Rigid card protection.");
    expect(offer.listingPolicies).not.toHaveProperty("bestOfferTerms");
  });

  it.each([
    ["the price", { pricingSummary: { price: { value: "14.00", currency: "USD" } } }, ["priceCents"]],
    ["the description", { listingDescription: "<p>Edited again</p>" }, ["offerDescriptionHash"]],
    ["the quantity", { availableQuantity: 2 }, ["availableQuantity"]],
  ])("refuses retryably, writing nothing and recording no attempt, when the vendor changed %s after the pre-read", async (_name, patch, changed) => {
    const fetcher = new FakeFetch([jsonResponse({ offers: [liveOffer(patch)] })]);
    const attempts: Array<{ sent: DropshipMarketplaceListingPushSent; fetcherCalls: number }> = [];
    await expect(createEbayProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch).pushListing(
      request({ passthrough: { title: null, description: null, bestOfferTerms: null, carriedFingerprints: NONE_CARRIED } }, attempts, fetcher))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_CHANGED_DURING_PUSH", context: expect.objectContaining({ changedFields: changed, retryable: true }) });
    expect(writes(fetcher)).toEqual([]);
    expect(attempts).toEqual([]);
  });

  it("keeps the vendor's shipping policy already live on the listing even when the fresh check flags it (SB10); never one it would introduce", async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const provider = (fetcher: FakeFetch) => new EbayDropshipListingPushProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch,
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
      { evaluateForStoreConnection: async () => incompatiblePreflight(), evaluateWithAccessToken: async () => incompatiblePreflight() },
      managedLocationProvider(), () => quantityAdmission, undefined, { stockReadiness: legacyStockReadiness(), sleep: async () => {},
        logger: { debug, warn } });
    const kept = new FakeFetch([jsonResponse({ offers: [liveOffer()] }), emptyResponse(), emptyResponse()]);
    const keptRequest = request({ passthrough: { title: null, description: null, bestOfferTerms: null, carriedFingerprints: NONE_CARRIED },
      liveFulfillmentPolicyId: "fulfillment-policy" }, [], kept);
    await expect(provider(kept).pushListing(keptRequest)).resolves.toMatchObject({ externalOfferId: "offer-101" });
    // ARCH-11: expected and already told to the vendor and staff, so DEBUG on every push, with the push's correlation ids.
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ action: "dropship.listing_push.live_policy_kept",
      listing_id: keptRequest.listingId, vendor_id: keptRequest.vendorId, job_id: keptRequest.jobId, job_item_id: keptRequest.jobItemId }));
    expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ action: "dropship.listing_push.live_policy_kept" }));

    const other = new FakeFetch([]);
    await expect(provider(other).pushListing(request({ passthrough: { title: null, description: null, bestOfferTerms: null, carriedFingerprints: NONE_CARRIED },
      liveFulfillmentPolicyId: "another-policy" }, [], other))).rejects.toMatchObject({ code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE" });
    expect(other.calls).toEqual([]);
  });
});
