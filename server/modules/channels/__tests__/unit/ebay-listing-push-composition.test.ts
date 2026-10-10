import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  auth: { getVerifiedProviderAccount: vi.fn(), getAccessToken: vi.fn() },
  repository: {
    withProductLock: vi.fn(), readProduct: vi.fn(), readCategory: vi.fn(), readVariants: vi.fn(),
    currentListingIds: vi.fn(), readAspects: vi.fn(), projectSuccess: vi.fn(), recordFailure: vi.fn(),
  },
  connector: { pushListing: vi.fn(), previewListingRebuild: vi.fn(), updateExistingListing: vi.fn(), executeListingRebuild: vi.fn() },
  photos: vi.fn(), prices: vi.fn(), quantities: vi.fn(), build: vi.fn(), identity: vi.fn(),
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
vi.mock("../../ebay-listing-draft", () => ({ buildEbayRouteListingDraft: fixture.build }));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: fixture.identity }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", () => ({ createEbayMarketplaceRegistrationAdapters: () => ({ observer: {} }) }));
vi.mock("../../infrastructure/ebay-listing-push.repository", () => ({
  PostgresEbayListingPushRepository: class { constructor() { return fixture.repository; } },
}));
vi.mock("../../listing-connectors/ebay-listing.connector", () => ({
  EbayMarketplaceListingConnector: class { constructor() { return fixture.connector; } },
}));

import { ebayListingPushService } from "../../infrastructure/ebay-listing-push";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";

describe("eBay publication application composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.repository.withProductLock.mockImplementation((_id: number, work: () => Promise<unknown>) => work());
    fixture.query.mockResolvedValue({ rows: [{ id: 34, metadata: { marketplaceId: "EBAY_US" } }] });
    fixture.auth.getVerifiedProviderAccount.mockResolvedValue({ externalAccountId: "seller-1" });
    fixture.auth.getAccessToken.mockResolvedValue("test-only-token");
    fixture.repository.readProduct.mockImplementation(async (id: number) => ({ id, name: `Product ${id}`, sku: "CATALOG-GROUP", product_type: "pack", ebay_browse_category_id: "123" }));
    fixture.repository.readCategory.mockResolvedValue(null);
    fixture.repository.readVariants.mockResolvedValue([{ id: 101, sku: "PROVIDER-PACK", catalog_sku: "CATALOG-PACK", price_cents: 999, external_variant_id: "offer-101", external_product_id: null }]);
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
  });

  it("uses the provider alias for publication and the catalog identity for photos, then projects only after the provider completes", async () => {
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.summary.succeeded).toBe(1);
    expect(fixture.photos.mock.calls[0][0].variants).toEqual([{ variantId: 101, sku: "CATALOG-PACK" }]);
    expect(fixture.build.mock.calls[0][0].variants[0].sku).toBe("PROVIDER-PACK");
    expect(fixture.repository.projectSuccess.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.connector.pushListing.mock.invocationCallOrder[0]);
    expect(fixture.connector.executeListingRebuild).not.toHaveBeenCalled();
    expect(fixture.repository.recordFailure).not.toHaveBeenCalled();
  });

  it("isolates preparation failures inside the real product owner and continues the next product", async () => {
    fixture.photos.mockRejectedValueOnce(new EbayListingSyncError("EBAY_CATALOG_PHOTO_REQUIRED", "Include a photo for this variant."));
    const result = await ebayListingPushService.push({ productIds: [20, 21] });
    expect(result.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0, total: 2 });
    expect(result.results[0].issue?.action.kind).toBe("edit_photos");
    expect(fixture.repository.recordFailure).toHaveBeenCalledExactlyOnceWith(20, "Include a photo for this variant.");
    expect(fixture.repository.projectSuccess.mock.calls[0][0]).toBe(21);
  });

  it("requires Sync for an already mapped listing without overwriting its status", async () => {
    fixture.repository.currentListingIds.mockResolvedValue(["listing-20"]);
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

  it("reports a lost local projection as unconfirmed instead of claiming publication completed", async () => {
    fixture.repository.projectSuccess.mockRejectedValue(new Error("database write failed"));
    const result = await ebayListingPushService.push({ productIds: [20] });
    expect(result.summary.succeeded).toBe(0);
    expect(result.results[0]).toMatchObject({ success: false, code: "EBAY_SYNC_PERSISTENCE_FAILED" });
    expect(fixture.repository.recordFailure).toHaveBeenCalledOnce();
  });
});
