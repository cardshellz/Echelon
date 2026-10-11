import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayListingSyncExecution } from "../../ebay-listing-sync.service";
import type { EbayListingLifecycleClient, EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import type { EbayInventoryItem, EbayInventoryItemGroup } from "../../adapters/ebay/ebay-types";
import type { EbayRegistrationReadTransport } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { captureExistingEbayListingIdentity } from "../../ebay-existing-listing-identity";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const fixture = vi.hoisted(() => ({
  execution: null as EbayListingSyncExecution | null,
  rows: [] as Array<Record<string, unknown>>,
  client: null as EbayListingLifecycleClient | null,
  transport: null as EbayRegistrationReadTransport | null,
  photoRequests: [] as Array<{ variants: Array<{ variantId: number; sku: string }> }>,
  recovery: vi.fn(async () => ({ busy: false, resolved: [], unresolved: [] })),
  readCount: 0,
  changeSource: false,
  atp: vi.fn(),
}));
vi.mock("../../../../db", () => ({ pool: {}, db: { select: () => {
  const query = { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
    limit: async () => [{ id: 12, metadata: { marketplaceId: "EBAY_US", fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns" } }],
    orderBy: async () => {
      fixture.readCount++;
      return fixture.rows.map((row, index) => fixture.changeSource && fixture.readCount > 1 && index === 0 ? { ...row, variant_sku: "RENAMED-AFTER-ADMISSION" } : row);
    },
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return query;
} } }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller" }), getAccessToken: async () => "test-only", getEnvironment: () => "production" }),
  atpService: { getAtpPerVariant: fixture.atp },
  ebayListingPhotoResolver: { resolve: async (input: { variants: Array<{ variantId: number; sku: string }> }) => {
    fixture.photoRequests.push(input);
    return { byVariantId: new Map(input.variants.map(member => [member.variantId, [`https://example.com/${member.variantId}.jpg`]])), groupImageUrls: ["https://example.com/shared.jpg"] };
  } },
}));
vi.mock("../../infrastructure/ebay-listing-client", () => ({ createEbayRouteListingLifecycleClient: () => fixture.client, getExistingEbayListingPhotos: vi.fn() }));
vi.mock("../../infrastructure/ebay-listing-helpers", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/ebay-listing-helpers")>(),
  resolveChannelPrice: async () => 1000, delay: async () => {},
}));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", async () => {
  const { EbayMarketplaceRegistrationObserver } = await import("../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer");
  return { createEbayMarketplaceRegistrationAdapters: () => ({ observer: new EbayMarketplaceRegistrationObserver(
    { loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) },
    fixture.transport!, { now: () => new Date("2026-10-09T20:00:00Z") },
  ) }) };
});
vi.mock("../../infrastructure/ebay-listing-sync.repository", () => ({ PostgresEbayListingSyncRepository: class {} }));
vi.mock("../../../inventory-planning/quantity-publication", () => ({ quantityProviderResponseRecovery: { reconcile: fixture.recovery } }));
vi.mock("../../ebay-listing-sync.service", async importOriginal => ({
  ...await importOriginal<typeof import("../../ebay-listing-sync.service")>(),
  EbayListingSyncService: class { constructor(_repository: unknown, execution: EbayListingSyncExecution) { fixture.execution = execution; } },
}));
import { readExistingEbayListingIdentityForProduct, readExistingEbayListingMappingIdentity, readExistingEbayListingMappingSource } from "../../infrastructure/ebay-active-listing-sync";

const cases = [
  { productId: 3, catalog: "SHLZ-TOP-180PT-CLR", group: "SHLZ-TOP-180PT", suffixes: ["P10", "C500"], ids: [5, 6], listing: "298148206427", offers: ["136406510011", "136406511011"] },
  { productId: 86, catalog: "SHLZ-TOP-TCG-SLIM-CLR", group: "SHLZ-TOP-40PT-SLIM", suffixes: ["P25", "C1000"], ids: [175, 176], listing: "298148234994", offers: ["136411547011", "136411549011"] },
];
function provider(example: typeof cases[number]) {
  fixture.rows = example.ids.map((id, index) => ({ product_id: example.productId, product_name: "Current catalog title", product_sku: example.catalog,
    variant_id: id, variant_sku: `${example.catalog}-${example.suffixes[index]}`, variant_name: example.suffixes[index],
    external_sku: `${example.group}-${example.suffixes[index]}`, external_variant_id: example.offers[index], external_product_id: example.listing,
    product_is_active: true, variant_is_active: true, variant_sales_eligibility: "sellable", price_cents: 1000, last_synced_price: 900,
    variant_weight_grams: 100, option1_name: "Pack Size", option1_value: example.suffixes[index], ebay_browse_category_id: "183454" }));
  const source = captureExistingEbayListingIdentity(fixture.rows, { channelId: 67, connectionId: 12, accountId: "seller", marketplaceId: "EBAY_US" });
  const initial = syncProviderFixture();
  const items = new Map<string, EbayInventoryItem>(source.variants.map(member => [member.sku, { ...initial.currentItem(), sku: member.sku }]));
  const offers = new Map<string, EbayObservedOffer>(source.variants.map(member => [member.sku, { sku: member.sku, offerId: member.offerId!, listingId: member.listingId!, status: "PUBLISHED", marketplaceId: "EBAY_US", format: "FIXED_PRICE",
    availableQuantity: 17, categoryId: "183454", merchantLocationKey: "card-shellz-hq", pricingSummary: { price: { value: "9.00", currency: "USD" } },
    listingPolicies: { fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns" } }]));
  let group: EbayInventoryItemGroup = { ...initial.currentGroup(), variantSKUs: source.variants.map(member => member.sku), variesBy: { specifications: [{ name: "Pack Size", values: example.suffixes }] } };
  const client: EbayListingLifecycleClient = { ...initial.client,
    getInventoryItem: vi.fn(async sku => structuredClone(items.get(sku) ?? null)),
    getOffers: vi.fn(async sku => ({ offers: offers.has(sku) ? [structuredClone(offers.get(sku)!)] : [] })),
    getInventoryItemGroup: vi.fn(async key => { if (key !== example.group) throw new Error("Wrong group"); return structuredClone(group); }),
    createOrReplaceInventoryItem: vi.fn(async (sku, payload) => { items.set(sku, { ...structuredClone(payload), sku }); }),
    updateOffer: vi.fn(async (id, payload) => { offers.set(payload.sku, { ...structuredClone(payload), offerId: id, listingId: example.listing, status: "PUBLISHED" }); }),
    createOrReplaceInventoryItemGroup: vi.fn(async (_key, payload) => { group = structuredClone(payload); }),
  };
  fixture.client = client;
  fixture.transport = { get: vi.fn(async request => {
    const url = new URL(request.path, "https://api.ebay.com");
    if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: "seller", username: "seller" } };
    if (url.pathname.includes("/inventory_item_group/")) return { status: 200, body: group };
    if (url.pathname.includes("/inventory_item/")) {
      const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return { status: 200, body: { ...items.get(sku), groupIds: [example.group] } };
    }
    if (url.pathname.endsWith("/offer")) {
      const offer = offers.get(url.searchParams.get("sku")!)!;
      return { status: 200, body: { offers: [{ ...offer, listing: { listingId: example.listing, listingStatus: "ACTIVE" } }], total: 1 } };
    }
    throw new Error(`Unexpected provider read ${request.path}`);
  }) };
  return { source, client };
}
beforeEach(() => {
  fixture.readCount = 0; fixture.changeSource = false; fixture.photoRequests = []; fixture.recovery.mockClear();
  fixture.atp.mockReset().mockImplementation(async () => fixture.rows.map(row => ({ productVariantId: row.variant_id, atpUnits: 17 })));
});

describe("production existing-listing prepare through verified completion", () => {
  it("reads the transaction mapping identity without ATP or provider calls, retaining disabled members", async () => {
    const { source, client } = provider(cases[0]);
    fixture.rows[1].variant_is_active = false;
    const snapshot = await readExistingEbayListingMappingIdentity(cases[0].productId);
    expect(snapshot).toMatchObject({ environment: "production", identity: { variants: [
      expect.objectContaining({ variantId: source.variants[0].variantId, sku: source.variants[0].sku }),
      expect.objectContaining({ variantId: source.variants[1].variantId, sku: source.variants[1].sku, contentSyncEnabled: false }),
    ] } });
    expect(fixture.atp).not.toHaveBeenCalled();
    expect(fixture.transport!.get).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("adds quantity candidates through the canonical ATP reader without provider reads or writes", async () => {
    const { source, client } = provider(cases[0]);
    const snapshot = await readExistingEbayListingMappingSource(cases[0].productId);
    expect(snapshot.candidates).toEqual(source.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, availableQuantity: 17, isActive: true })));
    expect(fixture.atp).toHaveBeenCalledExactlyOnceWith(cases[0].productId);
    expect(fixture.transport!.get).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it.each(cases)("uses the same provider identity reader for product $productId preview, including disabled members", async example => {
    const { source, client } = provider(example);
    fixture.rows[1].variant_is_active = false;
    const identity = await readExistingEbayListingIdentityForProduct(example.productId);
    expect(identity).toMatchObject({ groupKey: example.group, variants: [
      expect.objectContaining({ variantId: example.ids[0], sku: source.variants[0].sku }),
      expect.objectContaining({ variantId: example.ids[1], sku: source.variants[1].sku, contentSyncEnabled: false }),
    ] });
    expect(fixture.photoRequests).toEqual([]);
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.updateOffer).not.toHaveBeenCalled();
  });
  it.each(cases)("completes product $productId using provider aliases in writes, recovery and final projection details", async example => {
    const { source, client } = provider(example);
    const binding = vi.fn(async () => {});
    const result = await fixture.execution!.execute(source, async (_key, _hash, work) => work(), null, binding);
    expect(result).toMatchObject({ synced: 2, errors: 0 });
    expect(result.details.map(detail => [detail.variantId, detail.variantSku])).toEqual(source.variants.map(member => [member.variantId, member.sku]));
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ groupKey: example.group }));
    expect(fixture.recovery).toHaveBeenCalledWith([`group:${example.group}`, ...source.variants.map(member => member.sku)].map(sku => expect.objectContaining({ externalInventoryItemId: sku })));
    expect(fixture.photoRequests[0].variants.map(member => member.sku)).toEqual(source.variants.map(member => member.catalogSku));
    expect(vi.mocked(client.createOrReplaceInventoryItem).mock.calls.map(([sku]) => sku)).toEqual(source.variants.map(member => member.sku));
    expect(vi.mocked(client.updateOffer).mock.calls.map(([id]) => id)).toEqual(example.offers);
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith(example.group, expect.objectContaining({ variantSKUs: source.variants.map(member => member.sku) }));
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.publishOffer).not.toHaveBeenCalled();
  });

  it("rejects a catalog mapping race after provider discovery and before binding or any provider write", async () => {
    const { source, client } = provider(cases[0]);
    fixture.changeSource = true;
    const binding = vi.fn(async () => {});
    await expect(fixture.execution!.execute(source, async (_key, _hash, work) => work(), null, binding)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(binding).not.toHaveBeenCalled();
    expect(fixture.recovery).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.updateOffer).not.toHaveBeenCalled();
  });
});
