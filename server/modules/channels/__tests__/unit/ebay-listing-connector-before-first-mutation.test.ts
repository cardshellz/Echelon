import { describe, expect, it, vi } from "vitest";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorDraft,
  type EbayObservedOffer,
  type EbayResolvedPushOffers,
} from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

// Fix PR 2a-2 (plan F2 2.1, D5): the optional beforeFirstMutation hook runs once,
// after offer discovery and any published identity proof, before the first write.
async function fixture(status: "UNPUBLISHED" | "PUBLISHED" = "UNPUBLISHED") {
  const provider = syncProviderFixture();
  const prepared = await provider.prepare();
  const draft: EbayListingConnectorDraft = { ...prepared.draft, itemGroup: null, publishMode: "publish", hasExistingExternalIds: false };
  const observed = (await provider.client.getOffers("P5", "EBAY_US")).offers[0]!;
  vi.mocked(provider.client.getOffers).mockClear();
  vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [status === "UNPUBLISHED"
    ? { ...observed, status: "UNPUBLISHED", listingId: undefined } : observed] });
  vi.mocked(provider.client.publishOffer).mockResolvedValue({ listingId: "listing-20" });
  return { client: provider.client, draft, observed, connector: new EbayMarketplaceListingConnector() };
}

const writes = (client: Awaited<ReturnType<typeof fixture>>["client"]) => [client.updateOffer, client.createOrReplaceInventoryItem,
  client.createOffer, client.createOrReplaceInventoryItemGroup, client.publishOffer, client.publishOfferByInventoryItemGroup];

describe("EbayMarketplaceListingConnector beforeFirstMutation", () => {
  it("runs once with the accepted offers, after the offer lookup and before any provider write", async () => {
    const f = await fixture();
    const order: string[] = [];
    vi.mocked(f.client.getOffers).mockImplementation(async () => { order.push("getOffers"); return { offers: [{ ...f.observed, status: "UNPUBLISHED", listingId: undefined }] }; });
    vi.mocked(f.client.updateOffer).mockImplementation(async () => { order.push("updateOffer"); });
    vi.mocked(f.client.createOrReplaceInventoryItem).mockImplementation(async () => { order.push("createOrReplaceInventoryItem"); });
    const hook = vi.fn(async (_resolved: EbayResolvedPushOffers) => { order.push("hook"); });

    await f.connector.pushListing({ ...f, beforeFirstMutation: hook });

    expect(hook).toHaveBeenCalledTimes(1);
    // eBay sync-back (SB5): the hook also gets the offer exactly as this push's own lookup returned it.
    expect(hook).toHaveBeenCalledWith({ offers: [{ variantId: 101, sku: "P5", existingOfferId: "offer-101",
      observedOffer: { ...f.observed, status: "UNPUBLISHED", listingId: undefined } }], verifiedPublishedListingId: null });
    expect(order.slice(0, 3)).toEqual(["getOffers", "hook", "updateOffer"]);
    expect(order.indexOf("hook")).toBeLessThan(order.indexOf("createOrReplaceInventoryItem"));
  });

  it("reports a genuinely new offer as existingOfferId null", async () => {
    const f = await fixture();
    vi.mocked(f.client.getOffers).mockResolvedValue({ offers: [] });
    vi.mocked(f.client.createOffer).mockResolvedValue("offer-new");
    const hook = vi.fn(async () => {});
    await f.connector.pushListing({ ...f, beforeFirstMutation: hook });
    expect(hook).toHaveBeenCalledWith({ offers: [{ variantId: 101, sku: "P5", existingOfferId: null, observedOffer: null }],
      verifiedPublishedListingId: null });
  });

  it("passes the proven published listing after the identity check", async () => {
    const f = await fixture("PUBLISHED");
    const hook = vi.fn(async () => {});
    const identity = (externalId: string) => ({ externalId, identityNamespace: "ebay:production" });
    const resolvePublishedIdentity = vi.fn(async () => ({
      providerAccount: { provider: "ebay" as const, accountNamespace: "ebay:production", externalAccountId: "verified-account",
        identityScheme: "provider_user_id" as const, externalDisplayNameSnapshot: null, evidenceHash: "a".repeat(64) },
      marketplaceId: "EBAY_US", publicationKeyIdentity: null, listingIdentity: identity("listing-20"), externalUrl: null, isPublished: true,
      members: [{ sku: "P5", variantIdentity: null, offerIdentity: identity("offer-101"), inventoryItemIdentity: identity("P5") }],
      evidence: {}, observedAt: new Date("2026-10-21T12:00:00.000Z"),
    }));
    await f.connector.pushListing({ ...f, resolvePublishedIdentity, beforeFirstMutation: hook });
    expect(resolvePublishedIdentity).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ offers: [{ variantId: 101, sku: "P5", existingOfferId: "offer-101", observedOffer: f.observed }],
      verifiedPublishedListingId: "listing-20" });
  });

  it.each([
    ["a different offer format", (observed: EbayObservedOffer) => ({ ...observed, format: "AUCTION" as const, status: "UNPUBLISHED" })],
    ["another SKU", (observed: EbayObservedOffer) => ({ ...observed, sku: "OTHER", status: "UNPUBLISHED" })],
  ])("never runs when discovery refuses %s", async (_name, change) => {
    const f = await fixture();
    vi.mocked(f.client.getOffers).mockResolvedValue({ offers: [change(f.observed) as unknown as EbayObservedOffer] });
    const hook = vi.fn(async () => {});
    await expect(f.connector.pushListing({ ...f, beforeFirstMutation: hook })).rejects.toMatchObject({ code: "EBAY_SYNC_MAPPING_INVALID" });
    expect(hook).not.toHaveBeenCalled();
    for (const write of writes(f.client)) expect(write).not.toHaveBeenCalled();
  });

  it("never runs when a published offer has no identity proof", async () => {
    const f = await fixture("PUBLISHED");
    const hook = vi.fn(async () => {});
    await expect(f.connector.pushListing({ ...f, beforeFirstMutation: hook })).rejects.toMatchObject({ code: "EBAY_SYNC_MAPPING_INVALID" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("stops the push with nothing written when the hook refuses", async () => {
    const f = await fixture();
    const refusal = Object.assign(new Error("No stock destination."), { code: "DROPSHIP_STOCK_DESTINATION_NOT_READY" });
    await expect(f.connector.pushListing({ ...f, beforeFirstMutation: async () => { throw refusal; } })).rejects.toBe(refusal);
    for (const write of writes(f.client)) expect(write).not.toHaveBeenCalled();
  });

  it("behaves exactly as before without a hook", async () => {
    const f = await fixture();
    await expect(f.connector.pushListing(f)).resolves.toMatchObject({ externalOfferIds: { 101: "offer-101" }, published: true });
    expect(f.client.updateOffer).toHaveBeenCalledTimes(1);
  });
});
