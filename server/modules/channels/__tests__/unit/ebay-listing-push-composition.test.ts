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
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { query: fixture.query }, getDatabasePoolSnapshot: () => ({ maximumConnections: 20 }) }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  EBAY_CHANNEL_ID: 67, atpService: { getAtpPerVariant: fixture.quantities },
  ebayListingPhotoResolver: { resolve: fixture.photos }, getAuthService: () => fixture.auth,
}));
vi.mock("../../infrastructure/ebay-listing-client", () => ({
  createEbayRouteListingClient: () => ({}), createEbayRouteListingLifecycleClient: () => ({}), getExistingEbayListingPhotos: vi.fn(),
}));
vi.mock("../../infrastructure/ebay-listing-helpers", () => ({ determineVariationAspectName: () => "Pack Size", resolveChannelPrice: fixture.prices }));
// The full writer, catalog adapter and saved-publication gate are exercised in
// ebay-business-policies.integration and ebay-policy-publication.integration.
vi.mock("../../ebay-business-policies", () => ({ ebayBusinessPolicies: { resolveProductPolicies: fixture.policies } }));
vi.mock("../../ebay-listing-draft", () => ({ buildEbayRouteListingDraft: fixture.build }));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: fixture.identity }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", () => ({ createEbayMarketplaceRegistrationAdapters: () => ({ observer: {}, inspector: { inspectExistingPublication: fixture.inspect } }) }));
vi.mock("../../infrastructure/ebay-active-listing-sync", () => ({ ebayListingSyncService: fixture.jobs }));
vi.mock("../../infrastructure/ebay-listing-push.repository", () => ({
  PostgresEbayListingPushRepository: class { constructor() { return fixture.repository; } },
}));
vi.mock("../../listing-connectors/ebay-listing.connector", () => ({
  EbayMarketplaceListingConnector: class { constructor() { return fixture.connector; } },
}));

import { ebayListingPushService, prepareEbayPublicationCompletion, readEbayPublicationSource } from "../../infrastructure/ebay-listing-push";
import { EbayListingSyncError, storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";

describe("eBay publication application composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.repository.withProductLock.mockImplementation((_id: number, work: () => Promise<unknown>) => work());
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
    fixture.prices.mockResolvedValue(999);
    fixture.quantities.mockResolvedValue([{ productVariantId: 101, atpUnits: 8 }]);
    fixture.build.mockReturnValue({ inventoryItems: [], offers: [], itemGroup: undefined });
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
    expect(fixture.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ productId: 20 }), "ebay-listing-publish", expect.any(String), "publish");
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
    fixture.repository.readProduct.mockRejectedValueOnce(new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED", "Activate this product."));
    fixture.jobs.recordAdmissionFailure.mockImplementation(async value => ({ id: value.commandKey, kind: "admission", operation: "sync", productId: value.productId,
      state: "needs_attention", code: value.code, message: value.message, nextAttemptAt: "2026-10-11T20:00:00Z", updatedAt: "2026-10-11T20:00:00Z" }));
    const result = await ebayListingPushService.push({ productIds: [20, 21] });
    expect(result.summary).toEqual({ succeeded: 0, queued: 1, failed: 1, skipped: 0, total: 2 });
    expect(fixture.jobs.recordAdmissionFailure).toHaveBeenCalledOnce();
    expect(fixture.jobs.enqueue.mock.calls[0][0].productId).toBe(21);
  });

  it("requires Sync for an already mapped listing without overwriting its status", async () => {
    fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
    fixture.jobs.recordAdmissionFailure.mockResolvedValue({ id: "c7c3a7d4-6cdf-4cc9-a5a1-4d2e5e9c4bc1", productId: 20, operation: "sync", kind: "admission", state: "needs_attention" });
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.results[0].code).toBe("EBAY_LISTING_ALREADY_PUBLISHED");
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

  it("reports uncertain job admission without provider calls or claiming publication completed", async () => {
    fixture.jobs.enqueue.mockRejectedValue(new Error("database write failed"));
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.summary.succeeded).toBe(0);
    expect(result.results[0]).toMatchObject({ success: false, code: "EBAY_SYNC_ADMISSION_UNSAVED" });
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled(); expect(fixture.connector.pushListing).not.toHaveBeenCalled();
  });
});
