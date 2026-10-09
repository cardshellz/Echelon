import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayListingLifecycleClient, EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import type { EbayRegistrationReadTransport } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const state = vi.hoisted(() => ({
  product: {} as Record<string, unknown>, variants: [] as Array<Record<string, unknown>>,
  client: null as EbayListingLifecycleClient | null, transport: null as EbayRegistrationReadTransport | null,
  project: vi.fn(async () => {}), failure: vi.fn(async () => {}), accountId: "seller", extraMember: false, changedOffer: false,
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { query: async () => ({ rows: [{ id: 12, metadata: {
  marketplaceId: "EBAY_US", fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns",
} }] }) }, getDatabasePoolSnapshot: () => ({ maximumConnections: 10 }) }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller" }), getAccessToken: async () => "test-only" }),
  atpService: { getAtpPerVariant: async () => state.variants.map(variant => ({ productVariantId: variant.id, atpUnits: 17 })) },
  ebayListingPhotoResolver: { resolve: async () => ({
    byVariantId: new Map(state.variants.map(variant => [variant.id, ["https://example.com/shared.jpg"]])), groupImageUrls: ["https://example.com/shared.jpg"],
  }) },
}));
vi.mock("../../infrastructure/ebay-listing-push.repository", () => ({ PostgresEbayListingPushRepository: class {
  withProductLock(_id: number, work: () => Promise<unknown>) { return work(); }
  async readProduct() { return state.product; }
  async readCategory() { return { ebay_browse_category_id: "183454" }; }
  async readVariants() { return state.variants; }
  async currentListingIds() { return []; }
  async readAspects() { return { Brand: ["Card Shellz"] }; }
  projectSuccess = state.project;
  recordFailure = state.failure;
} }));
vi.mock("../../infrastructure/ebay-listing-client", () => ({ createEbayRouteListingClient: () => state.client,
  createEbayRouteListingLifecycleClient: () => state.client, getExistingEbayListingPhotos: vi.fn() }));
vi.mock("../../infrastructure/ebay-listing-helpers", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/ebay-listing-helpers")>(), resolveChannelPrice: async () => 1000,
}));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: vi.fn() }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", async () => {
  const { EbayMarketplaceRegistrationObserver } = await import("../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer");
  return { createEbayMarketplaceRegistrationAdapters: () => ({ observer: new EbayMarketplaceRegistrationObserver(
    { loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) }, state.transport!,
    { now: () => new Date("2026-10-09T20:00:00Z") },
  ) }) };
});
import { ebayListingPushService } from "../../infrastructure/ebay-listing-push";

const examples = [
  { productId: 3, catalog: "SHLZ-TOP-180PT-CLR", group: "SHLZ-TOP-180PT", suffixes: ["P10", "C500"], ids: [5, 6], listing: "298148206427", offers: ["136406510011", "136406511011"] },
  { productId: 86, catalog: "SHLZ-TOP-TCG-SLIM-CLR", group: "SHLZ-TOP-40PT-SLIM", suffixes: ["P25", "C1000"], ids: [175, 176], listing: "298148234994", offers: ["136411547011", "136411549011"] },
];
function provider(example = examples[0], grouped = true) {
  state.product = { id: example.productId, name: "Current title", sku: example.catalog, product_type: "Toploaders", ebay_browse_category_id: "183454" };
  state.variants = (grouped ? example.ids : example.ids.slice(0, 1)).map((id, index) => ({ id, sku: `${example.group}-${example.suffixes[index]}`,
    catalog_sku: `${example.catalog}-${example.suffixes[index]}`, name: example.suffixes[index], option1_name: "Pack Size", option1_value: example.suffixes[index],
    price_cents: 1000, weight_grams: 100, external_variant_id: null, external_product_id: null, external_sku: null }));
  const base = syncProviderFixture();
  const offers = new Map<string, EbayObservedOffer>(state.variants.map((variant, index) => [String(variant.sku), {
    sku: String(variant.sku), offerId: example.offers[index], status: "PUBLISHED", listingId: example.listing,
    marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 17, categoryId: "183454", merchantLocationKey: "HQ",
    pricingSummary: { price: { value: "10.00", currency: "USD" } },
    listingPolicies: { paymentPolicyId: "payment", fulfillmentPolicyId: "shipping", returnPolicyId: "returns" },
  }]));
  state.client = { ...base.client,
    getOffers: vi.fn(async sku => ({ offers: offers.has(sku) ? [structuredClone(offers.get(sku)!)] : [] })),
    publishOffer: vi.fn(async () => ({ listingId: example.listing })),
    publishOfferByInventoryItemGroup: vi.fn(async () => ({ listingId: example.listing })),
  };
  state.transport = { get: vi.fn(async request => {
    const url = new URL(request.path, "https://api.ebay.com");
    if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: state.accountId, username: state.accountId } };
    if (url.pathname.includes("/inventory_item_group/")) {
      if (!url.pathname.endsWith(example.group)) throw new Error("Guessed Catalog group");
      return { status: 200, body: { variantSKUs: [...offers.keys(), ...(state.extraMember ? ["UNMAPPED-MEMBER"] : [])] } };
    }
    if (url.pathname.includes("/inventory_item/")) {
      const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return { status: 200, body: { sku, groupIds: grouped ? [example.group] : [] } };
    }
    if (url.pathname.endsWith("/offer")) {
      const sku = url.searchParams.get("sku")!;
      const offer = offers.get(sku) ?? { ...offers.values().next().value!, sku, offerId: "unmapped-offer" };
      return { status: 200, body: { offers: [{ ...offer, ...(state.changedOffer ? { offerId: `${offer.offerId}-changed` } : {}),
        listing: { listingId: example.listing, listingStatus: "ACTIVE" } }], total: 1 } };
    }
    throw new Error(`Unexpected provider read ${request.path}`);
  }) };
  return state.client;
}
beforeEach(() => { state.project.mockClear(); state.failure.mockClear(); state.accountId = "seller"; state.extraMember = false; state.changedOffer = false; });

describe("production initial-publication replay through the canonical provider observer", () => {
  it("recovers a genuine single published offer without creating a catalog group", async () => {
    const client = provider(examples[0], false);
    const result = await ebayListingPushService.push({ productIds: [3] });
    expect(result.results[0]).toMatchObject({ success: true, listingId: examples[0].listing });
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.publishOffer).not.toHaveBeenCalled();
  });
  it.each(examples)("reuses product $productId's actual published group after local persistence loss and Catalog rename", async example => {
    const client = provider(example);
    const result = await ebayListingPushService.push({ productIds: [example.productId] });
    expect(result.results[0]).toMatchObject({ success: true, listingId: example.listing });
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith(example.group, expect.objectContaining({ variantSKUs: state.variants.map(variant => variant.sku) }));
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(state.project).toHaveBeenCalledWith(example.productId, state.variants,
      expect.objectContaining({ externalProductId: example.listing, externalOfferIds: Object.fromEntries(example.ids.map((id, index) => [id, example.offers[index]])) }), expect.any(Map), []);
  });

  it.each(["account", "extra_member", "changed_offer"])("rejects %s mismatch before the first provider write or local success", async mismatch => {
    const client = provider();
    if (mismatch === "account") state.accountId = "another-seller";
    if (mismatch === "extra_member") state.extraMember = true;
    if (mismatch === "changed_offer") state.changedOffer = true;
    const result = await ebayListingPushService.push({ productIds: [3] });
    expect(result.results[0]).toMatchObject({ success: false });
    expect(client.updateOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(state.project).not.toHaveBeenCalled();
  });
});
