import { describe, expect, it, vi } from "vitest";
import { captureExistingEbayListingIdentity } from "../../ebay-existing-listing-identity";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft";
import { EbayMarketplaceListingConnector, type EbayListingLifecycleClient } from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";
import type { EbayInventoryItemGroup } from "../../adapters/ebay/ebay-types";

function fixture() {
  const identity = captureExistingEbayListingIdentity([1, 2].map(id => ({ product_id: 20, variant_id: id,
    variant_sku: `CAT-${id}`, external_sku: `REMOTE-${id}`, external_variant_id: `offer-${id}`, external_product_id: "listing-20",
    content_sync_enabled: id === 1 })), { channelId: 67, connectionId: 12, accountId: "seller", marketplaceId: "EBAY_US" });
  identity.groupKey = "EXISTING-GROUP";
  const draft = buildEbayRouteListingDraft({ productId: 20, product: { sku: "RENAMED-CATALOG-GROUP", name: "Updated product name" },
    variants: identity.variants.map(member => ({ id: member.variantId, sku: member.sku, name: member.variantId === 1 ? "Pack" : "Changed catalog retired name",
      weight_grams: 100, price_cents: member.variantId === 1 ? 1000 : null, isListed: member.contentSyncEnabled })),
    // Excluded variant intentionally has no catalog image entry or valid price.
    photoPlan: { byVariantId: new Map([[1, ["https://example.com/pack.jpg"]]]), groupImageUrls: ["https://example.com/shared.jpg"] },
    aspects: { Brand: ["Card Shellz"] }, isMultiVariant: true, variationAspectName: "Size",
    variantPrices: new Map([[1, 1000]]), atpByVariantId: new Map([[1, 17]]), marketplaceId: "EBAY_US", ebayBrowseCategoryId: "183454",
    effectivePolicies: { fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns" },
    merchantLocationKey: "warehouse", storeCategoryNames: [], retainUnlistedVariantsInGroup: true, existingGroupKey: identity.groupKey });
  let group: EbayInventoryItemGroup = { ...draft.itemGroup!.payload, variesBy: { specifications: [{ name: "Size", values: ["Pack", "Retired case"] }] } };
  const retainedItem = { ...draft.inventoryItems[0].payload, sku: "REMOTE-2",
    product: { ...draft.inventoryItems[0].payload.product, title: "Original retained content", imageUrls: [], aspects: { Size: ["Retired case"] } } };
  const itemBySku = new Map([["REMOTE-1", { ...draft.inventoryItems[0].payload, sku: "REMOTE-1" }], ["REMOTE-2", retainedItem]]);
  const offers = identity.variants.map(member => ({ ...draft.offers[0].payload, sku: member.sku,
    offerId: member.offerId!, listingId: member.listingId!, status: "PUBLISHED" as const }));
  const client: EbayListingLifecycleClient = {
    ...syncProviderFixture().client,
    getInventoryItem: vi.fn(async sku => itemBySku.get(sku) ?? null),
    getInventoryItemGroup: vi.fn(async () => structuredClone(group)),
    getOffers: vi.fn(async sku => ({ offers: offers.filter(offer => offer.sku === sku).map(offer => structuredClone(offer)) })),
    updateOffer: vi.fn(async (id, payload) => { const index = offers.findIndex(offer => offer.offerId === id); offers[index] = { ...offers[index], ...payload }; }),
    createOrReplaceInventoryItem: vi.fn(async (sku, payload) => { itemBySku.set(sku, { ...payload, sku }); }),
    createOrReplaceInventoryItemGroup: vi.fn(async (_key, payload) => { group = structuredClone(payload); }),
  };
  const connector = new EbayMarketplaceListingConnector();
  const input = { client, identity, draft: { ...draft, productId: 20, marketplaceId: "EBAY_US" } };
  return { identity, input, connector, retainedItem, itemBySku, client, offers, group: () => group };
}

describe("existing listing maintenance retains disabled provider members", () => {
  it("updates enabled members without catalog photos/prices for retained members and preserves live variation values", async () => {
    const f = fixture();
    const original = structuredClone(f.retainedItem);
    const prepared = await f.connector.prepareExistingListingSyncDraft(f.input);
    expect(prepared.inventoryItems.map(item => item.sku)).toEqual(["REMOTE-1"]);
    expect(prepared.offers.map(offer => offer.variantId)).toEqual([1]);
    expect(prepared.itemGroup?.payload.variantSKUs).toEqual(["REMOTE-1", "REMOTE-2"]);
    expect(prepared.itemGroup?.payload.variesBy.specifications[0].values).toEqual(["Pack", "Retired case"]);
    const result = await f.connector.syncExistingListing({ ...f.input, draft: prepared });
    await f.connector.verifyExistingListing({ ...f.input, draft: prepared, offerIds: result.updatedOfferIds });
    expect(f.client.createOrReplaceInventoryItem).toHaveBeenCalledTimes(1);
    expect(f.client.updateOffer).toHaveBeenCalledTimes(1);
    expect(f.client.updateOffer).toHaveBeenCalledWith("offer-1", expect.anything());
    expect(f.itemBySku.get("REMOTE-2")).toEqual(original);
    expect(f.group().variantSKUs).toEqual(["REMOTE-1", "REMOTE-2"]);
  });

  it("does not perform any content writes if a retained offer identity changed", async () => {
    const f = fixture();
    const prepared = await f.connector.prepareExistingListingSyncDraft(f.input);
    f.offers[1].offerId = "different-offer";
    await expect(f.connector.syncExistingListing({ ...f.input, draft: prepared })).rejects.toMatchObject({ code: "EBAY_SYNC_RETAINED_IDENTITY_CHANGED" });
    expect(f.client.updateOffer).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(f.client.createOrReplaceInventoryItemGroup).not.toHaveBeenCalled();
  });

  it("rejects drafts that attempt to replace retained-member content", async () => {
    const f = fixture();
    f.input.draft.inventoryItems.push({ sku: "REMOTE-2", payload: f.retainedItem });
    await expect(f.connector.prepareExistingListingSyncDraft(f.input)).rejects.toMatchObject({ code: "EBAY_SYNC_DRAFT_SCOPE_INVALID" });
  });
});
