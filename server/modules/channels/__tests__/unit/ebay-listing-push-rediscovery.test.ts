import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayListingLifecycleClient, EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import type { EbayRegistrationReadTransport } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const state = vi.hoisted(() => ({
  product: {} as Record<string, unknown>, variants: [] as Array<Record<string, unknown>>,
  client: null as EbayListingLifecycleClient | null, transport: null as EbayRegistrationReadTransport | null,
  project: vi.fn(async () => {}), failure: vi.fn(async () => {}), accountId: "seller", extraMember: false, changedOffer: false,
  ensureStock: vi.fn(async () => {}),
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { query: async () => ({ rows: [{ id: 12, metadata: {
  marketplaceId: "EBAY_US", fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns",
} }] }) }, getDatabasePoolSnapshot: () => ({ maximumConnections: 10 }) }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller" }), getAccessToken: async () => "test-only", getEnvironment: () => "production" }),
  atpService: { getAtpPerVariant: async () => state.variants.map(variant => ({ productVariantId: variant.id, atpUnits: 17 })) },
  ebayListingPhotoResolver: { resolve: async () => ({
    byVariantId: new Map(state.variants.map(variant => [variant.id, ["https://example.com/shared.jpg"]])), groupImageUrls: ["https://example.com/shared.jpg"],
  }) },
}));
// This suite exercises provider identity rediscovery. Real inventory admission
// and enrollment are covered in the disposable PostgreSQL composition suite.
vi.mock("../../../inventory-planning/quantity-publication", async () => ({ ensureEbayPublicationReady: state.ensureStock,
  InventoryPublicationMembershipError: (await import("../../../inventory-planning/application/inventory-publication-membership.service")).InventoryPublicationMembershipError,
  InventoryPublicationSelectionError: (await import("../../../inventory-planning/infrastructure/inventory-publication-selection.reader")).InventoryPublicationSelectionError,
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
  return { createEbayMarketplaceRegistrationAdapters: () => { const observer = new EbayMarketplaceRegistrationObserver(
    { loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) }, state.transport!,
    { now: () => new Date("2026-10-09T20:00:00Z") },
  ); return { observer, inspector: observer }; } };
});
import { prepareEbayPublicationCompletion, readEbayPublicationSource } from "../../infrastructure/ebay-listing-push";
import { EbayPublicationCompletionExecution } from "../../ebay-publication-completion.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import type { EbayListingExecutionContext } from "../../ebay-listing-sync.service";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import { EbayListingSyncError, syncFailure } from "../../ebay-listing-sync.domain";
import { InventoryPublicationMembershipError } from "../../../inventory-planning/application/inventory-publication-membership.service";
import { InventoryPublicationSelectionError } from "../../../inventory-planning/infrastructure/inventory-publication-selection.reader";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";

async function runPublication(productId: number): Promise<{ success: boolean; identity: EbayListingSyncIdentity | null; error?: unknown }> {
  const context: EbayListingExecutionContext = { operation: "publish", jobId: "655ca747-20b9-4940-9c61-019baf1c11c1", requestedBy: "operator", publicationTarget: null, publicationAccepted: null,
    publicationWriteStarted: false, publicationWriteCompleted: false, publicationAcceptedRevision: null, claimedRevision: "1", publicationIntentHash: null,
    bindPublicationTarget: async identity => { context.publicationTarget = identity; }, bindPublicationAccepted: async value => { context.publicationAccepted = value; } };
  let identity: EbayListingSyncIdentity | null = null;
  const executor = new EbayPublicationCompletionExecution(prepareEbayPublicationCompletion,
    { reconcile: async () => ({ busy: false, resolved: [], unresolved: [] }) }, new EbayMarketplaceListingConnector(), async () => {});
  try {
    const result = await executor.execute(await readEbayPublicationSource(productId), async (_key, _hash, work) => work(), null,
      async value => { identity = value; }, context);
    return { success: result.errors === 0, identity };
  } catch (error) { return { success: false, error, identity }; }
}

const examples = [
  { productId: 3, catalog: "SHLZ-TOP-180PT-CLR", group: "SHLZ-TOP-180PT", suffixes: ["P10", "C500"], ids: [5, 6], listing: "298148206427", offers: ["136406510011", "136406511011"] },
  { productId: 86, catalog: "SHLZ-TOP-TCG-SLIM-CLR", group: "SHLZ-TOP-40PT-SLIM", suffixes: ["P25", "C1000"], ids: [175, 176], listing: "298148234994", offers: ["136411547011", "136411549011"] },
];
function provider(example = examples[0], grouped = true) {
  state.product = { id: example.productId, name: "Current title", sku: example.catalog, product_type: "Toploaders", ebay_browse_category_id: "183454" };
  state.variants = (grouped ? example.ids : example.ids.slice(0, 1)).map((id, index) => ({ id, sku: `${example.group}-${example.suffixes[index]}`,
    catalog_sku: `${example.catalog}-${example.suffixes[index]}`, name: example.suffixes[index], option1_name: "Pack Size", option1_value: example.suffixes[index],
    price_cents: 1000, weight_grams: 100, external_variant_id: null, external_product_id: null, external_sku: null, mapping_exists: false }));
  const base = syncProviderFixture();
  const offers = new Map<string, EbayObservedOffer>(state.variants.map((variant, index) => [String(variant.sku), {
    sku: String(variant.sku), offerId: example.offers[index], status: "PUBLISHED", listingId: example.listing,
    marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 17, categoryId: "183454", merchantLocationKey: "HQ",
    pricingSummary: { price: { value: "10.00", currency: "USD" } },
    listingPolicies: { paymentPolicyId: "payment", fulfillmentPolicyId: "shipping", returnPolicyId: "returns" },
  }]));
  const items = new Map(state.variants.map(variant => [String(variant.sku), { ...base.currentItem(), sku: String(variant.sku) }]));
  let group = { ...base.currentGroup(), variantSKUs: state.variants.map(variant => String(variant.sku)) };
  state.client = { ...base.client,
    getInventoryItem: vi.fn(async sku => structuredClone(items.get(sku) ?? null)),
    createOrReplaceInventoryItem: vi.fn(async (sku, payload) => { items.set(sku, { ...structuredClone(payload), sku }); }),
    getInventoryItemGroup: vi.fn(async () => structuredClone(group)),
    createOrReplaceInventoryItemGroup: vi.fn(async (_key, payload) => { group = { ...structuredClone(payload), variantSKUs: payload.variantSKUs! }; }),
    updateOffer: vi.fn(async (id, payload) => { offers.set(payload.sku!, { ...structuredClone(payload), offerId: id, status: "PUBLISHED", listingId: example.listing }); }),
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
beforeEach(() => { state.project.mockClear(); state.failure.mockClear(); state.ensureStock.mockReset(); state.accountId = "seller"; state.extraMember = false; state.changedOffer = false; });

describe("production initial-publication replay through the canonical provider observer", () => {
  it("keeps exact connection-selection failures actionable through preparation and the saved worker result", async () => {
    const client = provider();
    state.ensureStock.mockRejectedValueOnce(new InventoryPublicationSelectionError("CHANNEL_SELECTION_CONNECTION_UNRESOLVED",
      "Channel selection requires its one exact saved connection. Review the destination before publishing stock."));
    const result = await runPublication(3);
    const failure = syncFailure(result.error, 1, new Date("2026-10-12T12:00:00Z"));
    expect(result.error).toBeInstanceOf(EbayListingSyncError);
    expect(failure).toMatchObject({ state: "needs_attention", code: "CHANNEL_SELECTION_CONNECTION_UNRESOLVED",
      message: "Channel selection requires its one exact saved connection. Review the destination before publishing stock." });
    expect(resolveEbayListingIssue({ ...failure, productId: 3 })).toMatchObject({ retryable: false,
      action: { kind: "reconnect", href: "/channels/ebay#connection" } });
    expect(client.updateOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
  it("preserves the Inventory owner's actionable stock message and retries before any provider write", async () => {
    const client = provider();
    state.ensureStock.mockRejectedValueOnce(new InventoryPublicationMembershipError("STOCK_MAPPING_PROVIDER_BUSY", "A stock update is running for this listing. The saved request will retry."));
    const result = await runPublication(3);
    expect(result.error).toBeInstanceOf(EbayListingSyncError);
    expect(syncFailure(result.error, 1, new Date("2026-10-12T12:00:00Z"))).toMatchObject({ state: "recovering",
      code: "STOCK_MAPPING_PROVIDER_BUSY", message: "A stock update is running for this listing. The saved request will retry." });
    expect(client.updateOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
  it("does not expose an untyped persistence error from automatic stock preparation", async () => {
    provider();
    state.ensureStock.mockRejectedValueOnce(Object.assign(new Error("private database detail"), { code: "STOCK_MAPPING_PROVIDER_BUSY" }));
    const result = await runPublication(3);
    expect(result.error).not.toBeInstanceOf(EbayListingSyncError);
    expect(syncFailure(result.error, 1, new Date("2026-10-12T12:00:00Z")).message).not.toContain("private database detail");
  });
  it("recovers a genuine single published offer without creating a catalog group", async () => {
    const client = provider(examples[0], false);
    const result = await runPublication(3);
    expect(result).toMatchObject({ success: true, identity: { variants: [expect.objectContaining({ listingId: examples[0].listing })] } });
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.publishOffer).not.toHaveBeenCalled();
  });
  it.each(examples)("reuses product $productId's actual published group after local persistence loss and Catalog rename", async example => {
    const client = provider(example);
    const result = await runPublication(example.productId);
    expect(result).toMatchObject({ success: true, identity: { groupKey: example.group } });
    expect(client.createOrReplaceInventoryItemGroup).toHaveBeenCalledWith(example.group, expect.objectContaining({ variantSKUs: state.variants.map(variant => variant.sku) }));
    expect(client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(state.project).not.toHaveBeenCalled(); // Only the durable finish transaction may project.
    expect(result.identity?.variants.map(member => member.offerId)).toEqual(example.offers);
  });

  it.each(["account", "extra_member", "changed_offer"])("rejects %s mismatch before the first provider write or local success", async mismatch => {
    const client = provider();
    if (mismatch === "account") state.accountId = "another-seller";
    if (mismatch === "extra_member") state.extraMember = true;
    if (mismatch === "changed_offer") state.changedOffer = true;
    const result = await runPublication(3);
    expect(result).toMatchObject({ success: false });
    expect(client.updateOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(state.project).not.toHaveBeenCalled();
  });
});
