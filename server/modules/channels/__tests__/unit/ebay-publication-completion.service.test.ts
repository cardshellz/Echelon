import { describe, expect, it, vi } from "vitest";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { EbayPublicationCompletionExecution, type PreparedEbayPublication } from "../../ebay-publication-completion.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type { EbayListingExecutionContext } from "../../ebay-listing-sync.service";
import { resolveEbayPublicationTarget } from "../../ebay-publication-completion.domain";
import { syncContentIntentHash } from "../../ebay-listing-sync-content";
import { syncIdentity, syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

async function fixture(automaticRecovery?: ConstructorParameters<typeof EbayPublicationCompletionExecution>[4]) {
  const base = syncProviderFixture();
  let published = false; let visible = true;
  const source: EbayListingSyncIdentity = { ...syncIdentity, groupKey: null,
    variants: syncIdentity.variants.map(member => ({ ...member, externalSku: null, listingId: null, mappingExists: true })) };
  const getOffers = base.client.getOffers;
  base.client.getOffers = vi.fn(async (sku, marketplaceId) => ({ offers: (await getOffers(sku, marketplaceId)).offers.map(offer => ({ ...offer,
    status: published && visible ? "PUBLISHED" : "UNPUBLISHED", listingId: published && visible ? "listing-20" : undefined })) }));
  vi.mocked(base.client.publishOffer).mockImplementation(async () => { published = true; return { listingId: "listing-20" }; });
  const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) }, {
    get: async request => {
      const url = new URL(request.path, "https://example.invalid");
      if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: source.accountId } };
      if (url.pathname.includes("/inventory_item/")) return { status: 200, body: { sku: "P5", groupIds: [] } };
      const offers = (await base.client.getOffers("P5", "EBAY_US")).offers.map(offer => ({ ...offer,
        ...(offer.status === "PUBLISHED" ? { listing: { listingId: "listing-20", listingStatus: "ACTIVE" } } : {}) }));
      return { status: 200, body: { offers, total: offers.length } };
    },
  }, { now: () => new Date("2026-10-11T20:00:00Z") });
  const observationInput = { owner: { kind: "channel" as const, channelId: 1, productId: 20, provider: "ebay", marketplaceId: "EBAY_US" },
    memberCandidates: [{ productVariantId: 101, sku: "P5", isActive: true, availableQuantity: 7 }] };
  const inspect = () => observer.inspectExistingPublication(observationInput);
  const original = await base.prepare();
  const assertInventoryReady = vi.fn(async () => {});
  const prepare = vi.fn(async (): Promise<PreparedEbayPublication> => {
    const inspection = await inspect();
    return { ...original, assertInventoryReady, sourceIdentity: source, identity: resolveEbayPublicationTarget(source, inspection), inspection, inspect,
      draft: { ...original.draft, itemGroup: null, publishMode: "publish", hasExistingExternalIds: false,
        existingOfferIdsByVariantId: { 101: "offer-101" } },
      resolvePublishedIdentity: async () => (await inspect()).publication!,
    };
  });
  const recovery = { reconcile: vi.fn(async (): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }> => ({ busy: false, resolved: [], unresolved: [] })) };
  const context: EbayListingExecutionContext = { operation: "publish", publicationTarget: null, publicationAccepted: null,
    publicationWriteStarted: false, publicationAcceptedRevision: null, claimedRevision: "1", publicationIntentHash: null,
    publicationWriteCompleted: false, bindPublicationTarget: vi.fn(async value => { context.publicationTarget = value; }),
    bindPublicationAccepted: vi.fn(async value => { context.publicationAccepted = value; }) };
  const bind = vi.fn(); const compatibility = vi.fn(); const stages: string[] = [];
  const stage = vi.fn(async (key: string, _hash: string, work: () => Promise<void>) => {
    stages.push(`start:${key}`); if (key === "publish") context.publicationWriteStarted = true;
    await work(); stages.push(`done:${key}`);
    if (key === "publish") context.publicationWriteCompleted = true;
  });
  const executor = new EbayPublicationCompletionExecution(prepare, recovery, new EbayMarketplaceListingConnector(), compatibility, automaticRecovery);
  return { ...base, source, prepare, recovery, context, bind, compatibility, stages, assertInventoryReady,
    run: () => executor.execute(source, stage, null, bind, context),
    setVisibility: (value: boolean) => { visible = value; }, setPublished: () => { published = true; } };
}

describe("saved eBay publication completion", () => {
  it("rejects missing stock enrollment before any provider preparation write", async () => {
    const f = await fixture();
    f.assertInventoryReady.mockRejectedValue(new EbayListingSyncError("EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED", "Connect stock first."));
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED" });
    expect(f.client.updateOffer).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(f.client.publishOffer).not.toHaveBeenCalled();
  });
  it("reuses the exact offer, sends canonical photos, records acceptance and verifies publication before completion", async () => {
    const f = await fixture(); const result = await f.run();
    expect(result).toMatchObject({ synced: 1, errors: 0 });
    expect(f.client.createOffer).not.toHaveBeenCalled(); expect(f.client.publishOffer).toHaveBeenCalledExactlyOnceWith("offer-101");
    expect(f.context.publicationTarget?.variants[0].listingId).toBeNull();
    expect(f.context.publicationAccepted).toEqual({ listingId: "listing-20", offerIds: { 101: "offer-101" } });
    expect(f.bind).toHaveBeenCalledWith(expect.objectContaining({ variants: [expect.objectContaining({ listingId: "listing-20", offerId: "offer-101" })] }), expect.objectContaining({ isPublished: true }));
    expect(f.currentItem().product.imageUrls).toEqual(["https://example.com/pack.jpg"]);
    expect(vi.mocked(f.context.bindPublicationTarget).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.client.updateOffer).mock.invocationCallOrder[0]);
    expect(f.stages).toContain("done:publication_readback"); expect(f.stages).toContain("done:verification");
  });
  it("does not repeat an accepted publish while provider visibility is delayed across attempts", async () => {
    const f = await fixture(); f.setVisibility(false);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    const itemWrites = vi.mocked(f.client.createOrReplaceInventoryItem).mock.calls.length;
    f.assertInventoryReady.mockRejectedValue(new Error("Future stock configuration unavailable"));
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
    expect(f.client.createOrReplaceInventoryItem).toHaveBeenCalledTimes(itemWrites);
    f.setVisibility(true); expect((await f.run()).synced).toBe(1);
    expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
  });
  it("uses the durable completed publish stage when saving its acceptance marker failed", async () => {
    const f = await fixture(); f.setVisibility(false);
    f.context.bindPublicationAccepted = vi.fn(async () => { throw new Error("acceptance persistence unavailable"); });
    await expect(f.run()).rejects.toThrow("acceptance persistence unavailable");
    expect(f.context.publicationAccepted).toBeNull(); expect(f.context.publicationWriteCompleted).toBe(true);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
    f.setVisibility(true); expect((await f.run()).synced).toBe(1);
  });
  it("refreshes changed Catalog content after published readback without another publish", async () => {
    const f = await fixture(); const prepared = await f.prepare();
    f.context.publicationIntentHash = syncContentIntentHash(prepared.draft);
    f.setVisibility(false);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    prepared.draft.inventoryItems[0].payload.product!.imageUrls = ["https://example.com/new-current-photo.jpg"];
    f.setVisibility(true);
    expect((await f.run()).synced).toBe(1);
    expect(f.currentItem().product.imageUrls).toEqual(["https://example.com/new-current-photo.jpg"]);
    expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
  });
  it("does not treat current published readback as proof of an uncertain old HTTP outcome", async () => {
    const f = await fixture(); f.setPublished(); f.recovery.reconcile.mockResolvedValue({ busy: false, resolved: [], unresolved: ["16323"] });
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });
    expect(f.client.updateOffer).not.toHaveBeenCalled(); expect(f.client.publishOffer).not.toHaveBeenCalled();
  });
  it("never repeats a started publish without its completion receipt; published readback can finish it", async () => {
    const f = await fixture(); f.context.publicationWriteStarted = true;
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" });
    expect(f.client.publishOffer).not.toHaveBeenCalled(); expect(f.client.updateOffer).not.toHaveBeenCalled();
    f.setPublished();
    // Content still differs; verification waits without rewriting accepted work.
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    expect(f.client.publishOffer).not.toHaveBeenCalled(); expect(f.client.updateOffer).not.toHaveBeenCalled();
  });
  it("resumes the exact rejected publication with current photos and the existing offer after saving rejection proof", async () => {
    const f = await fixture();
    f.context.publicationWriteStarted = true;
    f.context.recoverRejectedPublicationWrite = vi.fn(async () => true);
    const prepared = await f.prepare();
    prepared.draft.inventoryItems[0].payload.product!.imageUrls = ["https://example.com/current-product-photo.jpg"];
    expect((await f.run()).synced).toBe(1);
    expect(f.context.recoverRejectedPublicationWrite).toHaveBeenCalledWith(expect.objectContaining({
      variants: [expect.objectContaining({ sku: "P5", offerId: "offer-101", listingId: null })],
    }));
    expect(vi.mocked(f.context.recoverRejectedPublicationWrite).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.client.createOrReplaceInventoryItem).mock.invocationCallOrder[0]);
    expect(f.currentItem().product.imageUrls).toEqual(["https://example.com/current-product-photo.jpg"]);
    expect(f.client.createOffer).not.toHaveBeenCalled();
    expect(f.client.publishOffer).toHaveBeenCalledExactlyOnceWith("offer-101");
  });
  it("retains a started publication when its HTTP evidence cannot prove rejection", async () => {
    const f = await fixture();
    f.context.publicationWriteStarted = true;
    f.context.recoverRejectedPublicationWrite = vi.fn(async () => false);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" });
    expect(f.client.publishOffer).not.toHaveBeenCalled();
    expect(f.client.updateOffer).not.toHaveBeenCalled();
  });
  it("does not write if the rejection checkpoint cannot commit", async () => {
    const f = await fixture();
    f.context.publicationWriteStarted = true;
    f.context.recoverRejectedPublicationWrite = vi.fn(async () => { throw new Error("rejection receipt rollback"); });
    await expect(f.run()).rejects.toThrow("rejection receipt rollback");
    expect(f.client.publishOffer).not.toHaveBeenCalled();
    expect(f.client.updateOffer).not.toHaveBeenCalled();
  });
  it("records a current refusal and preserves the provider's actionable error instead of reporting uncertainty", async () => {
    const f = await fixture();
    const rejected = new EbayListingSyncError("EBAY_SHIPPING_POLICY_REJECTED", "eBay rejected the shipping policy.");
    vi.mocked(f.client.publishOffer).mockRejectedValue(rejected);
    f.context.recoverRejectedPublicationWrite = vi.fn(async () => true);
    await expect(f.run()).rejects.toBe(rejected);
    expect(f.context.recoverRejectedPublicationWrite).toHaveBeenCalledOnce();
    expect(f.client.publishOffer).toHaveBeenCalledOnce();
  });
  it("uses automatic stock recovery when a saved publication is already live without publishing again", async () => {
    const recover = vi.fn(async () => ({ busy: false, superseded: ["17032"], unresolved: [], watchId: "1" }));
    const f = await fixture({ recover });
    f.context.jobId = "f52374be-d3aa-4542-a83c-127285c582db";
    f.context.requestedBy = "operator";
    f.setPublished();
    f.recovery.reconcile.mockResolvedValue({ busy: false, resolved: [], unresolved: ["17032"] });
    expect((await f.run()).synced).toBe(1);
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ syncJobId: f.context.jobId, syncRevision: "1" }));
    expect(f.assertInventoryReady).toHaveBeenCalledWith({ commandKey: f.context.jobId, actor: "operator" });
    expect(f.client.createOrReplaceInventoryItem).toHaveBeenCalledOnce();
    expect(f.client.publishOffer).not.toHaveBeenCalled();
  });
  it("never requests rejection recovery after accepted publication while visibility is delayed", async () => {
    const f = await fixture();
    f.setVisibility(false);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    f.context.recoverRejectedPublicationWrite = vi.fn(async () => true);
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_PUBLICATION_READBACK_PENDING" });
    expect(f.context.recoverRejectedPublicationWrite).not.toHaveBeenCalled();
    expect(f.client.publishOffer).toHaveBeenCalledOnce();
  });
  it("refuses regrouping between Finish Publishing review and execution", async () => {
    const f = await fixture(); f.source.groupKey = "REVIEWED-GROUP";
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(f.context.bindPublicationTarget).not.toHaveBeenCalled(); expect(f.client.publishOffer).not.toHaveBeenCalled();
  });
  it("stops before any write if provider resources changed from the saved target", async () => {
    const f = await fixture(); f.context.publicationTarget = { ...(await f.prepare()).identity, groupKey: "FOREIGN" };
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(f.client.updateOffer).not.toHaveBeenCalled(); expect(f.recovery.reconcile).not.toHaveBeenCalled();
  });
  it("stops before provider writes when canonical ownership is incompatible", async () => {
    const f = await fixture(); f.compatibility.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_CANONICAL_CONFLICT", "Already registered elsewhere."));
    await expect(f.run()).rejects.toMatchObject({ code: "EBAY_MAPPING_CANONICAL_CONFLICT" });
    expect(f.client.publishOffer).not.toHaveBeenCalled(); expect(f.client.updateOffer).not.toHaveBeenCalled();
  });
});
