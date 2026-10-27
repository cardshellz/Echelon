import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const capturedGroup = JSON.parse(readFileSync(resolve(process.cwd(), "server/modules/channels/__tests__/fixtures/ebay-armalope-group-readback.json"), "utf8")) as Record<string, unknown>;
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  ebayApiRequest: api.request,
  ebayApiRequestWithRateNotify: api.request,
  getAuthService: () => null,
  EBAY_CHANNEL_ID: 67,
}));
import { createEbayRouteListingLifecycleClient, normalizeEbayObservedInventoryItemGroup, normalizeEbayObservedOffers } from "../../infrastructure/ebay-listing-client";
import { ebayListingPushFailure } from "../../ebay-listing-push.service";
import type { EbayQuantityRequestAdmission } from "../../quantity-publication-request";

describe("eBay inventory group read response contract", () => {
  beforeEach(() => api.request.mockReset());
  it("reads the exact offer endpoint when a collection omits its shipping policy", async () => {
    const response = { offerId: "offer-6", sku: "PACK", marketplaceId: "EBAY_US", status: "PUBLISHED",
      listing: { listingId: "listing-6" }, listingPolicies: { fulfillmentPolicyId: "shipping-6" } };
    api.request.mockResolvedValue(response);
    const client = createEbayRouteListingLifecycleClient({ accessToken: "mock-access-token" });
    expect(await client.getOffer!("offer-6")).toMatchObject(response);
    expect(api.request).toHaveBeenCalledExactlyOnceWith("GET", "/sell/inventory/v1/offer/offer-6", "mock-access-token", undefined);
  });
  it("withdrawal composes the real reducing request owner without requiring positive-stock target mappings", async () => {
    const reducing = vi.fn((_identity: string, _members?: readonly string[]) => undefined);
    const positive = vi.fn(async (): Promise<never> => { throw new Error("PUBLICATION_LISTING_TARGET_UNMAPPED"); });
    const admission: EbayQuantityRequestAdmission = { item: positive, group: positive,
      reducing: async <T>(identity: string, work: () => Promise<T>, members?: readonly string[]): Promise<T> => {
        reducing(identity, members);
        return work();
      } };
    api.request.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path.includes("inventory_item_group/")) return { variantSKUs: ["OLD-P10", "OLD-C500"] };
      if (method === "GET" && path.includes("/offer/")) return { sku: "OLD-P10", marketplaceId: "EBAY_US" };
      return undefined;
    });
    const client = createEbayRouteListingLifecycleClient({ accessToken: "test-only", quantityAdmission: async () => admission });
    await client.withdrawOfferByInventoryItemGroup("OLD", "EBAY_US");
    await client.withdrawOffer("offer-6");
    expect(positive).not.toHaveBeenCalled();
    expect(reducing.mock.calls.map(([identity, members]) => ({ identity, members }))).toEqual([
      { identity: "group:OLD", members: ["OLD-C500", "OLD-P10"] }, { identity: "OLD-P10", members: undefined },
    ]);
    expect(api.request.mock.calls.filter(([method]) => method === "POST").map(([_method, path, _token, body]) => ({ path, body }))).toEqual([
      { path: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group", body: { inventoryItemGroupKey: "OLD", marketplaceId: "EBAY_US" } },
      { path: "/sell/inventory/v1/offer/offer-6/withdraw", body: undefined },
    ]);
  });
  it("reads the exact requested resource and preserves the captured body without inventing a key", async () => {
    api.request.mockResolvedValue(structuredClone(capturedGroup));
    const client = createEbayRouteListingLifecycleClient({ accessToken: "mock-access-token" });
    const response = await client.getInventoryItemGroup("ARM-ENV-DBL");
    expect(api.request).toHaveBeenCalledExactlyOnceWith("GET", "/sell/inventory/v1/inventory_item_group/ARM-ENV-DBL", "mock-access-token", undefined);
    expect(response).toEqual(capturedGroup);
    expect(response).not.toHaveProperty("inventoryItemGroupKey");
    expect(response?.imageUrls).toHaveLength(2);
    expect(response?.variantSKUs).toEqual(["ARM-ENV-DBL-C300", "ARM-ENV-DBL-P50"]);
  });
  it.each([
    { imageUrls: [42] }, { variantSKUs: [true] }, { description: null },
    { variesBy: { specifications: [{ name: "Style", values: [false] }] } },
    { inventoryItemGroupKey: null },
  ])("rejects invalid provider fields without disclosing values", invalid => {
    expect(() => normalizeEbayObservedInventoryItemGroup({ ...capturedGroup, ...invalid })).toThrowError(
      expect.objectContaining({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID" }),
    );
  });
  it.each([{}, { offers: [{ offerId: "secret-provider-value", status: "BROKEN" }] }])("classifies malformed offer reads without exposing the response body", response => {
    let failure;
    try { normalizeEbayObservedOffers(response); }
    catch (error) { failure = ebayListingPushFailure(20, error); }
    expect(failure).toMatchObject({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID", issue: { action: { kind: "review_mapping" } } });
    expect(JSON.stringify(failure)).not.toContain("secret-provider-value");
  });
  it.each([undefined, null, "", "  ", 42])("classifies an absent or invalid echoed SKU as invalid provider evidence, not a mapping mismatch: %s", sku => {
    expect(() => normalizeEbayObservedOffers({ offers: [{ sku, offerId: "offer", status: "PUBLISHED", listing: { listingId: "listing" } }] }))
      .toThrowError(expect.objectContaining({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID" }));
  });
  it("preserves the returned identity and refuses conflicting listing identifiers", () => {
    expect(normalizeEbayObservedOffers({ offers: [{ sku: "SKU", offerId: "offer", status: "PUBLISHED", listing: { listingId: "listing" } }] }))
      .toEqual([{ sku: "SKU", offerId: "offer", status: "PUBLISHED", listingId: "listing", listing: { listingId: "listing" } }]);
    expect(() => normalizeEbayObservedOffers({ offers: [{ sku: "SKU", offerId: "offer", status: "PUBLISHED", listingId: "different", listing: { listingId: "listing" } }] }))
      .toThrowError(expect.objectContaining({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID" }));
  });
  it.each([null, {}, { offerId: 42 }, { offerId: " " }])("classifies incomplete offer creation without claiming creation failed", async response => {
    api.request.mockResolvedValue(response);
    const admission: EbayQuantityRequestAdmission = { item: async (_sku, work) => work(0), group: async (_key, _skus, work) => work(new Map()), reducing: async (_identity, work) => work() };
    const client = createEbayRouteListingLifecycleClient({ accessToken: "test-only", quantityAdmission: async () => admission });
    const failure = await client.createOffer({ sku: "SKU", marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 0, categoryId: "123",
      listingPolicies: { paymentPolicyId: "pay", fulfillmentPolicyId: "ship", returnPolicyId: "return" }, merchantLocationKey: "HQ",
      pricingSummary: { price: { value: "1.00", currency: "USD" } } }).catch(error => ebayListingPushFailure(20, error));
    expect(failure).toMatchObject({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID", issue: { action: { kind: "review_mapping" } } });
    expect(typeof failure !== "string" && failure.error).toContain("offer may exist");
    expect(api.request).toHaveBeenCalledOnce();
  });
  it("classifies absent verified account before the listing write", async () => {
    const client = createEbayRouteListingLifecycleClient({ accessToken: "test-only" });
    await expect(client.createOrReplaceInventoryItem("SKU", { condition: "NEW", product: { title: "Product", imageUrls: [] },
      availability: { shipToLocationAvailability: { quantity: 1 } } })).rejects.toMatchObject({ code: "EBAY_SYNC_AUTH_REQUIRED" });
    expect(api.request).not.toHaveBeenCalled();
  });
});
