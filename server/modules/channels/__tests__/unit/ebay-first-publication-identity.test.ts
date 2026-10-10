import { describe, expect, it, vi } from "vitest";
import { EbayMarketplaceListingConnector, type EbayListingConnectorDraft, type EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";
import { ebayListingPushFailure } from "../../ebay-listing-push.service";

async function fixture() {
  const provider = syncProviderFixture();
  const prepared = await provider.prepare();
  const draft: EbayListingConnectorDraft = { ...prepared.draft, itemGroup: null, publishMode: "publish", hasExistingExternalIds: false };
  const observed = (await provider.client.getOffers("P5", "EBAY_US")).offers[0];
  vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [{ ...observed, status: "UNPUBLISHED", listingId: undefined }] });
  vi.mocked(provider.client.publishOffer).mockResolvedValue({ listingId: "listing-20" });
  return { client: provider.client, draft, connector: new EbayMarketplaceListingConnector() };
}

describe("first publication offer identity", () => {
  it.each(["inventoryItems", "offers"] as const)("exposes the known missing %s requirement with a correction action", async field => {
    const f = await fixture();
    f.draft[field] = [];
    const failure = await f.connector.pushListing(f).catch(error => ebayListingPushFailure(f.draft.productId, error));
    expect(failure).toMatchObject({ code: "EBAY_LISTING_VALIDATION_FAILED", issue: { action: { kind: "edit_listing" } } });
    expect("error" in failure && failure.error).toContain("At least one eBay");
    expect(f.client.updateOffer).not.toHaveBeenCalled();
  });
  it.each(["different_sku", "different_marketplace", "different_format", "ambiguous"])("refuses %s before any provider mutation", async condition => {
    const f = await fixture();
    const observed = (await f.client.getOffers("P5", "EBAY_US")).offers[0];
    const other = { ...observed, offerId: "other", ...(condition === "different_sku" ? { sku: "WRONG" } : {}),
      ...(condition === "different_marketplace" ? { marketplaceId: "EBAY_GB" } : {}),
      ...(condition === "different_format" ? { format: "AUCTION" as const } : {}) };
    // Exercise malformed provider identities, including a non-supported format.
    const invalidOffer = other as unknown as EbayObservedOffer;
    vi.mocked(f.client.getOffers).mockResolvedValue({ offers: condition === "ambiguous" ? [observed, invalidOffer] : [invalidOffer] });
    await expect(f.connector.pushListing(f)).rejects.toMatchObject({ code: "EBAY_SYNC_MAPPING_INVALID" });
    expect(f.client.updateOffer).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(f.client.createOffer).not.toHaveBeenCalled();
  });

  it("does not trust an unobserved saved offer ID", async () => {
    const f = await fixture();
    f.draft.existingOfferIdsByVariantId = { 101: "different-saved-offer" };
    await expect(f.connector.pushListing(f)).rejects.toMatchObject({ code: "EBAY_SYNC_MAPPING_INVALID" });
    expect(f.client.updateOffer).not.toHaveBeenCalled();
  });

  it.each(["PUBLISHED", undefined])("requires canonical listing proof for an offer with published identity and status %s", async status => {
    const f = await fixture();
    const observed = (await f.client.getOffers("P5", "EBAY_US")).offers[0];
    vi.mocked(f.client.getOffers).mockResolvedValue({ offers: [{ ...observed, status, listingId: "listing-20" }] });
    await expect(f.connector.pushListing(f)).rejects.toMatchObject({ code: "EBAY_SYNC_MAPPING_INVALID" });
    expect(f.client.updateOffer).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
    expect(f.client.publishOffer).not.toHaveBeenCalled();
  });

  it("rediscovers an offer after interrupted creation instead of creating it twice", async () => {
    const f = await fixture();
    const observed = (await f.client.getOffers("P5", "EBAY_US")).offers[0];
    let created = false;
    vi.mocked(f.client.getOffers).mockImplementation(async () => ({ offers: created ? [observed] : [] }));
    vi.mocked(f.client.createOffer).mockImplementation(async () => { created = true; throw Object.assign(new Error("Response lost"), { code: "ECONNRESET" }); });
    await expect(f.connector.pushListing(f)).rejects.toThrow("Response lost");
    // Actual retries also require the inventory owner's response recovery or
    // explicit audited resume, independently tested with PostgreSQL.
    await expect(f.connector.pushListing(f)).resolves.toMatchObject({ externalOfferIds: { 101: "offer-101" } });
    expect(f.client.createOffer).toHaveBeenCalledTimes(1);
    expect(f.client.updateOffer).toHaveBeenCalledWith("offer-101", expect.objectContaining({ sku: "P5" }));
  });
});
