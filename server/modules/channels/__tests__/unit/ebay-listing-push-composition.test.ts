import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  auth: { getVerifiedProviderAccount: vi.fn(), getAccessToken: vi.fn(), getEnvironment: vi.fn() },
  repository: {
    withProductLock: vi.fn(), readProduct: vi.fn(), readCategory: vi.fn(), readVariants: vi.fn(),
    currentListingIds: vi.fn(), readAspects: vi.fn(), projectSuccess: vi.fn(), recordFailure: vi.fn(),
  },
  connector: { pushListing: vi.fn(), previewListingRebuild: vi.fn(), updateExistingListing: vi.fn(), executeListingRebuild: vi.fn() },
  photos: vi.fn(), prices: vi.fn(), quantities: vi.fn(), policies: vi.fn(), build: vi.fn(), identity: vi.fn(),
  inspect: vi.fn(), jobs: { getByCommand: vi.fn(), getAdmission: vi.fn(), enqueue: vi.fn(), recordAdmissionFailure: vi.fn() },
  liveGroup: vi.fn(), sync: vi.fn(),
  intents: { open: vi.fn(), close: vi.fn() }, stockLink: vi.fn(),
}));
vi.mock("../../infrastructure/ebay-listing-change-intent.repository", () => ({
  EbayListingChangeIntentRepository: class { constructor() { return fixture.intents; } },
}));
// The hook's own suite covers what it links; here it only succeeds or refuses.
vi.mock("../../infrastructure/ebay-listing-stock-link-hook", () => ({ linkEbayListingStockBeforeChange: fixture.stockLink }));
vi.mock("../../../../db", () => ({ db: {}, pool: { query: fixture.query }, getDatabasePoolSnapshot: () => ({ maximumConnections: 20 }) }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  EBAY_CHANNEL_ID: 67, atpService: { getAtpPerVariant: fixture.quantities },
  ebayListingPhotoResolver: { resolve: fixture.photos }, getAuthService: () => fixture.auth,
}));
vi.mock("../../infrastructure/ebay-listing-client", () => ({
  createEbayRouteListingClient: () => ({}), createEbayRouteListingLifecycleClient: () => ({ getInventoryItemGroup: fixture.liveGroup, getInventoryItem: async () => null }), getExistingEbayListingPhotos: vi.fn(),
}));
vi.mock("../../infrastructure/ebay-listing-helpers", () => ({ determineVariationAspectName: () => "Pack Size", resolveChannelPriceResolution: fixture.prices }));
// The full writer, catalog adapter and saved-publication gate are exercised in
// ebay-business-policies.integration and ebay-policy-publication.integration.
vi.mock("../../ebay-business-policies", () => ({ ebayBusinessPolicies: { resolveProductPolicies: fixture.policies } }));
vi.mock("../../ebay-listing-draft", () => ({ buildEbayRouteListingDraft: fixture.build }));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: fixture.identity }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", () => ({ createEbayMarketplaceRegistrationAdapters: () => ({ observer: {}, inspector: { inspectExistingPublication: fixture.inspect } }) }));
vi.mock("../../infrastructure/ebay-channel-listing-sync", () => ({ syncChannelListings: fixture.sync }));
vi.mock("../../infrastructure/ebay-active-listing-sync", () => ({ ebayListingSyncService: fixture.jobs }));
vi.mock("../../infrastructure/ebay-listing-push.repository", () => ({
  PostgresEbayListingPushRepository: class { constructor() { return fixture.repository; } },
}));
vi.mock("../../listing-connectors/ebay-listing.connector", async importOriginal => ({
  ...await importOriginal<typeof import("../../listing-connectors/ebay-listing.connector")>(),
  EbayMarketplaceListingConnector: class { constructor() { return fixture.connector; } },
}));

import { ebayListingPushService, prepareEbayPublicationCompletion, readEbayPublicationSource } from "../../infrastructure/ebay-listing-push";
import { EbayListingSyncError, storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";
import { assertEbayPreparedIntent } from "../../ebay-prepared-intent";

describe("eBay publication application composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.sync.mockImplementation(async (filter, _actor, commandKey) => ({ synced: 0, pending: 1, errors: 0, details: [], jobs: [{ id: commandKey, productId: filter.productIds[0], operation: "publish", kind: "sync", state: "queued" }] }));
    fixture.repository.withProductLock.mockImplementation((_id: number, work: () => Promise<unknown>) => work());
    fixture.intents.open.mockResolvedValue(undefined); fixture.intents.close.mockResolvedValue(1); fixture.stockLink.mockResolvedValue(undefined);
    fixture.query.mockResolvedValue({ rows: [{ id: 34, metadata: { marketplaceId: "EBAY_US" } }] });
    fixture.auth.getVerifiedProviderAccount.mockResolvedValue({ externalAccountId: "seller-1" });
    fixture.auth.getAccessToken.mockResolvedValue("test-only-token");
    fixture.auth.getEnvironment.mockReturnValue("production");
    fixture.policies.mockImplementation(async (input: { expectedScope: unknown; variantIds: number[] }) => {
      const policies = { fulfillmentPolicyId: "shipping", returnPolicyId: "returns", paymentPolicyId: "payment" };
      return { scope: input.expectedScope, product: policies, byVariantId: new Map(input.variantIds.map(id => [id, { ...policies }])) };
    });
    fixture.repository.readProduct.mockImplementation(async (id: number) => ({ id, name: `Product ${id}`, sku: "CATALOG-GROUP", product_type: "pack", ebay_browse_category_id: "123" }));
    fixture.repository.readCategory.mockResolvedValue(null);
    fixture.repository.readVariants.mockResolvedValue([{ id: 101, sku: "PROVIDER-PACK", catalog_sku: "CATALOG-PACK", price_cents: 999, external_variant_id: "offer-101", external_product_id: null, external_sku: "PROVIDER-PACK", mapping_exists: true }]);
    fixture.repository.currentListingIds.mockResolvedValue([]);
    fixture.repository.readAspects.mockResolvedValue({});
    fixture.photos.mockResolvedValue({});
    fixture.prices.mockResolvedValue({ priceCents: 999, basePriceCents: 999, source: "catalog_variant", provenance: { kind: "catalog_variant", variantId: 101 }, appliedRule: null });
    fixture.quantities.mockResolvedValue([{ productVariantId: 101, atpUnits: 8 }]);
    fixture.build.mockReturnValue({ inventoryItems: [], offers: [{ variantId: 101, sku: "PROVIDER-PACK", payload: { pricingSummary: { price: { currency: "USD", value: "9.99" } } } }], itemGroup: undefined });
    fixture.connector.pushListing.mockResolvedValue({ externalProductId: "listing-20", externalOfferIds: { 101: "offer-101" } });
    fixture.identity.mockResolvedValue({ groupKey: "PROVIDER-GROUP" });
    fixture.repository.projectSuccess.mockResolvedValue(undefined);
    fixture.repository.recordFailure.mockResolvedValue(undefined);
    fixture.jobs.getByCommand.mockResolvedValue(null); fixture.jobs.getAdmission.mockResolvedValue(null);
    fixture.jobs.enqueue.mockImplementation(async (identity, _actor, id) => storedEbayListingSyncJobSchema.parse({
      id, operation: "publish", productId: identity.productId, state: "queued", code: null, message: null,
      nextAttemptAt: "2026-10-11T20:00:00Z", updatedAt: "2026-10-11T20:00:00Z", identity, revision: "1", claimedRevision: null,
      ownerToken: null, attempts: 0, result: null, verificationIntentHash: null, verificationRevision: null,
    }));
    fixture.inspect.mockResolvedValue({ providerAccount: { provider: "ebay", externalAccountId: "seller-1" },
      observedAt: new Date("2026-10-11T20:00:00Z"), skus: [{ sku: "PROVIDER-PACK", inventoryItemExists: true,
        offers: [{ sku: "PROVIDER-PACK", offerId: "offer-101", status: "UNPUBLISHED", listingId: null, listingStatus: null }], issue: null }],
      unpublishedTarget: { groupKey: null, skus: ["PROVIDER-PACK"] }, publication: null, publicationIssue: null, groupKey: null, groupSkus: null });
  });

  it("queues ordinary Publish without provider calls or claiming success", async () => {
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.summary.queued).toBe(1); expect(result.summary.succeeded).toBe(0);
    expect(fixture.sync).toHaveBeenCalledWith({ productIds: [20] }, "ebay-listing-publish", expect.any(String));
    expect(fixture.jobs.enqueue).not.toHaveBeenCalled();
    expect(fixture.connector.pushListing).not.toHaveBeenCalled(); expect(fixture.photos).not.toHaveBeenCalled();
    expect(fixture.repository.projectSuccess).not.toHaveBeenCalled();
  });

  it("uses the provider alias for publication and Catalog identity for photos in the shared worker preparation", async () => {
    const source = await readEbayPublicationSource(20);
    await prepareEbayPublicationCompletion(source, null);
    expect(fixture.photos.mock.calls[0][0].variants).toEqual([{ variantId: 101, sku: "CATALOG-PACK" }]);
    expect(fixture.photos.mock.calls[0][0].mode).toBe("catalog");
    expect(fixture.build.mock.calls[0][0].variants[0].sku).toBe("PROVIDER-PACK");
    expect(fixture.policies).toHaveBeenCalledWith({ productId: 20, variantIds: [101], expectedScope: {
      channelId: 67, connectionId: 34, accountId: "seller-1", environment: "production", marketplaceId: "EBAY_US",
    } });
    expect(fixture.repository.projectSuccess).not.toHaveBeenCalled();
    expect(fixture.connector.executeListingRebuild).not.toHaveBeenCalled();
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled();
  });

  it("keeps intentionally absent ATP rows under the existing draft builder policy", async () => {
    fixture.quantities.mockResolvedValue([]);
    const source = await readEbayPublicationSource(20);
    await expect(prepareEbayPublicationCompletion(source, null)).resolves.toMatchObject({ sourceIdentity: source });
    expect(fixture.inspect.mock.calls[0][0].memberCandidates).toEqual([{ productVariantId: 101, sku: "PROVIDER-PACK", isActive: true, availableQuantity: 0 }]);
    // No synthesized availability row is added to the quantity owner's input.
    expect(fixture.build.mock.calls[0][0].atpByVariantId).toEqual(new Map());
    expect(fixture.connector.pushListing).not.toHaveBeenCalled();
  });

  it("isolates admission failures and continues the next product", async () => {
    fixture.sync.mockResolvedValueOnce({ synced: 0, pending: 0, errors: 1, details: [{ success: false, productId: 20, code: "CHANNEL_SYNC_PRODUCT_INACTIVE", error: "Activate this product." }], jobs: [] });
    fixture.jobs.recordAdmissionFailure.mockImplementation(async value => ({ id: value.commandKey, kind: "admission", operation: "sync", productId: value.productId,
      state: "needs_attention", code: value.code, message: value.message, nextAttemptAt: "2026-10-11T20:00:00Z", updatedAt: "2026-10-11T20:00:00Z" }));
    const result = await ebayListingPushService.push({ productIds: [20, 21] });
    expect(result.summary).toEqual({ succeeded: 0, queued: 1, failed: 1, skipped: 0, total: 2 });
    expect(result.results[0].code).toBe("CHANNEL_SYNC_PRODUCT_INACTIVE");
    expect(fixture.sync.mock.calls[1][0]).toEqual({ productIds: [21] });
    expect(fixture.jobs.recordAdmissionFailure).not.toHaveBeenCalled();
  });

  it("delegates an already mapped listing to the same Sync owner", async () => {
    fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
    fixture.jobs.recordAdmissionFailure.mockResolvedValue({ id: "c7c3a7d4-6cdf-4cc9-a5a1-4d2e5e9c4bc1", productId: 20, operation: "sync", kind: "admission", state: "needs_attention" });
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.results[0]).toMatchObject({ status: "queued", success: false });
    expect(fixture.sync).toHaveBeenCalledWith({ productIds: [20] }, "ebay-listing-publish", expect.any(String));
    expect(fixture.connector.pushListing).not.toHaveBeenCalled();
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled();
  });

  it("uses the observed provider group for Analyze and does not persist a preview failure", async () => {
    fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
    fixture.connector.previewListingRebuild.mockRejectedValue(new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "Review this group."));
    const result = await ebayListingPushService.push({ productIds: [20], rebuild: { mode: "preview" } });
    expect(result.results[0].code).toBe("EBAY_SYNC_MAPPING_INVALID");
    expect(fixture.build.mock.calls[0][0].existingGroupKey).toBe("PROVIDER-GROUP");
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled();
    expect(fixture.repository.projectSuccess).not.toHaveBeenCalled();
    expect(fixture.connector.pushListing).not.toHaveBeenCalled();
    expect(fixture.connector.executeListingRebuild).not.toHaveBeenCalled();
  });

  it("aligns reviewed in-place update content before creating its prepared envelope", async () => {
    fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
    // Channels PR4: the stock-link hook reads ATP first; at 0 it links nothing (its own suite covers linking).
    fixture.quantities.mockResolvedValue([{ productVariantId: 101, atpUnits: 0 }]);
    const routeDraft = {inventoryItems:[{sku:"PROVIDER-PACK",payload:{condition:"NEW",product:{title:"Pack",imageUrls:[],aspects:{"Pack Size":["100"]}}}}],
      offers:[{variantId:101,sku:"PROVIDER-PACK",payload:{pricingSummary:{price:{currency:"USD",value:"9.99"}}}}],
      itemGroup:{groupKey:"PROVIDER-GROUP",payload:{title:"Pack",description:"Pack",aspects:{},imageUrls:[],variantSKUs:["PROVIDER-PACK"],variesBy:{specifications:[{name:"Pack Size",values:["100"]}]}}}};
    fixture.build.mockReturnValue(routeDraft);
    fixture.liveGroup.mockResolvedValue({...routeDraft.itemGroup.payload,inventoryItemGroupKey:"PROVIDER-GROUP",variesBy:{specifications:[{name:"Number of Sleeves",values:["100"]}]}});
    fixture.connector.updateExistingListing.mockResolvedValue({externalProductId:"listing-20",externalOfferIds:{101:"offer-101"}});
    const result = await ebayListingPushService.push({productIds:[20],updateExisting:{mode:"execute",preview:{productId:20,groupKey:"PROVIDER-GROUP",
      currentExternalListingId:"listing-20",sourceState:"active",currentSkus:["PROVIDER-PACK"],activeSkus:["PROVIDER-PACK"],inactiveSkus:[],desiredSkus:["PROVIDER-PACK"],
      addedSkus:[],removedSkus:[],rebuildRequired:false,confirmationToken:"a".repeat(64)}}});
    expect(result.summary.succeeded).toBe(1);
    const prepared = fixture.connector.updateExistingListing.mock.calls[0][0].draft;
    expect(prepared.inventoryItems[0].payload.product.aspects).toEqual({"Number of Sleeves":["100"]});
    expect(prepared.itemGroup.payload.variesBy.specifications[0].name).toBe("Number of Sleeves");
    expect(prepared.preparedIntent).toBeDefined();
    expect(()=>assertEbayPreparedIntent(prepared)).not.toThrow();
    expect(routeDraft.inventoryItems[0].payload.product.aspects).toEqual({"Pack Size":["100"]});
  });

  describe("a reviewed in-place update that adds a size", () => {
    const TOKEN = "c".repeat(64);
    const update = (addedSkus: string[]) => {
      fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
      fixture.repository.readVariants.mockResolvedValue([
        { id: 101, sku: "PROVIDER-PACK", catalog_sku: "CATALOG-PACK", price_cents: 999, external_variant_id: "offer-101", external_product_id: "listing-20", external_sku: "PROVIDER-PACK", mapping_exists: true },
        { id: 102, sku: "NEW-CASE", catalog_sku: "NEW-CASE", price_cents: 4999, external_variant_id: null, external_product_id: null, external_sku: null, mapping_exists: false }]);
      fixture.quantities.mockResolvedValue([{ productVariantId: 101, atpUnits: 8 }, { productVariantId: 102, atpUnits: 5 }]);
      fixture.prices.mockImplementation(async (_db: unknown, _channelId: number, _productId: number, variantId: number, priceCents: number) => ({
        priceCents, basePriceCents: priceCents, source: "catalog_variant", provenance: { kind: "catalog_variant", variantId }, appliedRule: null }));
      const item = (sku: string, size: string) => ({ sku, payload: { condition: "NEW", product: { title: "Pack", imageUrls: [], aspects: { "Pack Size": [size] } } } });
      const routeDraft = { inventoryItems: [item("PROVIDER-PACK", "100"), item("NEW-CASE", "2500")],
        offers: [{ variantId: 101, sku: "PROVIDER-PACK", payload: { pricingSummary: { price: { currency: "USD", value: "9.99" } } } },
          { variantId: 102, sku: "NEW-CASE", payload: { pricingSummary: { price: { currency: "USD", value: "49.99" } } } }],
        itemGroup: { groupKey: "PROVIDER-GROUP", payload: { title: "Pack", description: "Pack", aspects: {}, imageUrls: [], variantSKUs: ["PROVIDER-PACK", "NEW-CASE"],
          variesBy: { specifications: [{ name: "Pack Size", values: ["100", "2500"] }] } } } };
      fixture.build.mockReturnValue(routeDraft);
      fixture.liveGroup.mockResolvedValue({ ...routeDraft.itemGroup.payload, inventoryItemGroupKey: "PROVIDER-GROUP", variantSKUs: ["PROVIDER-PACK"] });
      fixture.connector.updateExistingListing.mockResolvedValue({ externalProductId: "listing-20", externalOfferIds: { 101: "offer-101", 102: "offer-102" } });
      return ebayListingPushService.push({ productIds: [20], updateExisting: { mode: "execute", preview: { productId: 20, groupKey: "PROVIDER-GROUP",
        currentExternalListingId: "listing-20", sourceState: "active", currentSkus: ["PROVIDER-PACK"], activeSkus: ["PROVIDER-PACK"], inactiveSkus: [],
        desiredSkus: ["PROVIDER-PACK", "NEW-CASE"], addedSkus, removedSkus: [], rebuildRequired: false, confirmationToken: TOKEN } } }, { actor: "user:operator" });
    };
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0];

    it("records the added size before the stock link and any eBay call, then closes it as applied", async () => {
      const result = await update(["NEW-CASE"]);
      expect(result.summary.succeeded).toBe(1);
      expect(fixture.intents.open).toHaveBeenCalledTimes(1);
      expect(fixture.intents.open.mock.calls[0][0]).toEqual({ kind: "listing_update", channelId: 67, connectionId: 34, productId: 20,
        externalListingId: "listing-20", reviewToken: TOKEN, actor: "user:operator", members: [{ productVariantId: 102, sku: "NEW-CASE" }] });
      expect(order(fixture.intents.open)).toBeLessThan(order(fixture.stockLink));
      expect(order(fixture.stockLink)).toBeLessThan(order(fixture.connector.updateExistingListing));
      expect(order(fixture.repository.projectSuccess)).toBeLessThan(order(fixture.intents.close));
      expect(fixture.intents.close).toHaveBeenCalledTimes(1);
      expect(fixture.intents.close.mock.calls[0][0]).toEqual({ channelId: 67, productId: 20, reviewToken: TOKEN, reason: "applied" });
    });

    it("records nothing when the reviewed change adds no size", async () => {
      expect((await update([])).summary.succeeded).toBe(1);
      expect(fixture.intents.open).not.toHaveBeenCalled();
      expect(fixture.intents.close).not.toHaveBeenCalled();
      expect(fixture.stockLink).toHaveBeenCalledTimes(1);
    });

    it("withdraws the record when the stock link refuses, and sends nothing to eBay", async () => {
      fixture.stockLink.mockRejectedValue(new EbayListingSyncError("STOCK_LISTING_HELD", "This stock destination is on hold."));
      const result = await update(["NEW-CASE"]);
      expect(result.results[0]).toMatchObject({ success: false, code: "STOCK_LISTING_HELD" });
      expect(fixture.connector.updateExistingListing).not.toHaveBeenCalled();
      expect(fixture.intents.close.mock.calls.map(call => call[0])).toEqual([{ channelId: 67, productId: 20, reviewToken: TOKEN, reason: "refused" }]);
    });

    it("withdraws the record when eBay changed since the review, which the connector checks before its first write", async () => {
      const result = update(["NEW-CASE"]);
      fixture.connector.updateExistingListing.mockRejectedValue(new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED", "The live eBay listing changed after review."));
      expect((await result).results[0]).toMatchObject({ success: false, code: "EBAY_LISTING_REVIEW_CHANGED" });
      expect(fixture.intents.close.mock.calls.map(call => call[0].reason)).toEqual(["refused"]);
    });

    it("keeps the record open when the change fails after eBay writes may have begun, so the size keeps receiving stock", async () => {
      const result = update(["NEW-CASE"]);
      fixture.connector.updateExistingListing.mockRejectedValue(new Error("eBay 500 while publishing the group"));
      expect((await result).results[0]).toMatchObject({ success: false });
      expect(fixture.intents.close).not.toHaveBeenCalled();
      // Saved locally or not, eBay may carry the size: the same holds when the local mapping could not be saved.
      vi.clearAllMocks(); fixture.repository.withProductLock.mockImplementation((_id: number, work: () => Promise<unknown>) => work());
      fixture.intents.open.mockResolvedValue(undefined); fixture.stockLink.mockResolvedValue(undefined); fixture.repository.recordFailure.mockResolvedValue(undefined);
      const unsaved = update(["NEW-CASE"]);
      fixture.repository.projectSuccess.mockRejectedValue(new Error("database unavailable"));
      expect((await unsaved).results[0]).toMatchObject({ success: false, code: "EBAY_SYNC_PERSISTENCE_FAILED" });
      expect(fixture.intents.close).not.toHaveBeenCalled();
    });

    it("stops before the stock link and eBay when the addition cannot be recorded", async () => {
      const result = update(["NEW-CASE"]);
      fixture.intents.open.mockRejectedValue(new Error("lock timeout"));
      expect((await result).results[0]).toMatchObject({ success: false });
      expect(fixture.stockLink).not.toHaveBeenCalled();
      expect(fixture.connector.updateExistingListing).not.toHaveBeenCalled();
      expect(fixture.intents.close).not.toHaveBeenCalled();
    });

    it("reports the applied change as a success even when its record could not be closed", async () => {
      const result = update(["NEW-CASE"]);
      fixture.intents.close.mockRejectedValue(new Error("lock timeout"));
      expect((await result).summary.succeeded).toBe(1);
    });
  });

  it("reports uncertain job admission without provider calls or claiming publication completed", async () => {
    fixture.sync.mockResolvedValue({ synced: 0, pending: 0, errors: 1, jobs: [], details: [{ success: false, productId: 20, code: "EBAY_SYNC_ADMISSION_UNSAVED", error: "Retry the same saved request." }] });
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.summary.succeeded).toBe(0);
    expect(result.results[0]).toMatchObject({ success: false, code: "EBAY_SYNC_ADMISSION_UNSAVED" });
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled(); expect(fixture.connector.pushListing).not.toHaveBeenCalled();
  });
});
