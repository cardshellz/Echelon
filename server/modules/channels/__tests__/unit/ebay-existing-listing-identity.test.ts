import { describe, expect, it, vi } from "vitest";
import {
  captureExistingEbayListingIdentity,
  assertEbayListingSourceIdentityUnchanged,
  resolveExistingEbayListingIdentity,
  type ExistingEbayListingIdentityRow,
} from "../../ebay-existing-listing-identity";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import type { EbayRegistrationReadRequest, EbayRegistrationReadResponse } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft";
import { readExistingEbayListingPhotos } from "../../adapters/ebay/ebay-listing-photos.reader";

const account = { channelId: 67, connectionId: 12, accountId: "seller-verified", marketplaceId: "EBAY_US" };
const now = new Date("2026-10-09T20:00:00Z");
const cases = [
  { productId: 3, catalogGroup: "SHLZ-TOP-180PT-CLR", group: "SHLZ-TOP-180PT", suffixes: ["P10", "C500"], ids: [5, 6], listing: "298148206427", offers: ["136406510011", "136406511011"] },
  { productId: 86, catalogGroup: "SHLZ-TOP-TCG-SLIM-CLR", group: "SHLZ-TOP-40PT-SLIM", suffixes: ["P25", "C1000"], ids: [175, 176], listing: "298148234994", offers: ["136411547011", "136411549011"] },
];
function rowsFor(fixture = cases[0]): ExistingEbayListingIdentityRow[] {
  return fixture.ids.map((variantId, index) => ({ product_id: fixture.productId, variant_id: variantId,
    variant_sku: `${fixture.catalogGroup}-${fixture.suffixes[index]}`, external_sku: `${fixture.group}-${fixture.suffixes[index]}`,
    external_variant_id: fixture.offers[index], external_product_id: fixture.listing }));
}

/** Real shared provider observer + transport responses matching the incident's GET contracts. */
function provider(source: EbayListingSyncIdentity, groupKey: string | null, extraSku?: string) {
  const state = { accountId: source.accountId, groupKey, offerIds: source.variants.map(member => member.offerId!),
    skus: [...source.variants.map(member => member.sku), ...(extraSku ? [extraSku] : [])] };
  const get = vi.fn(async (request: EbayRegistrationReadRequest): Promise<EbayRegistrationReadResponse> => {
    const url = new URL(request.path, "https://api.ebay.com");
    if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: state.accountId, username: "seller" } };
    if (url.pathname.includes("/inventory_item_group/")) {
      if (decodeURIComponent(url.pathname.split("/").at(-1)!) !== state.groupKey) throw new Error("Wrong group requested");
      // The actual group GET does not return inventoryItemGroupKey.
      return { status: 200, body: { variantSKUs: state.skus } };
    }
    if (url.pathname.includes("/inventory_item/")) {
      const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (!state.skus.includes(sku)) return { status: 404, body: {} };
      return { status: 200, body: { sku, groupIds: state.groupKey === null ? [] : [state.groupKey] } };
    }
    if (url.pathname.endsWith("/offer")) {
      const sku = url.searchParams.get("sku")!;
      const index = state.skus.indexOf(sku);
      const offers = index < 0 ? [] : [{ offerId: state.offerIds[index] ?? "extra-offer", sku, marketplaceId: "EBAY_US", status: "PUBLISHED",
        listing: { listingId: source.variants[0].listingId, listingStatus: "OUT_OF_STOCK" } }];
      return { status: 200, body: { offers, total: offers.length } };
    }
    throw new Error(`Unexpected provider read ${request.path}`);
  });
  const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) },
    { get }, { now: () => now });
  return { state, get, observer };
}
function candidates(source: EbayListingSyncIdentity) {
  return source.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, isActive: true, availableQuantity: 17 }));
}
function draft(source: EbayListingSyncIdentity, catalogGroup: string) {
  return buildEbayRouteListingDraft({ productId: source.productId, product: { sku: catalogGroup, name: "Toploader" },
    variants: source.variants.map((member, index) => ({ id: member.variantId, sku: member.sku, name: `Pack ${index + 1}`, weight_grams: 100,
      price_cents: 1000, isListed: true })),
    photoPlan: { byVariantId: new Map(source.variants.map(member => [member.variantId, [`https://example.com/${member.variantId}.jpg`]])),
      groupImageUrls: ["https://example.com/shared.jpg"] },
    aspects: { Brand: ["Card Shellz"] }, isMultiVariant: source.variants.length > 1, variationAspectName: "Pack size",
    variantPrices: new Map(source.variants.map(member => [member.variantId, 1000])),
    atpByVariantId: new Map(source.variants.map(member => [member.variantId, 17])), marketplaceId: "EBAY_US", ebayBrowseCategoryId: "183454",
    effectivePolicies: { fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns" },
    merchantLocationKey: "warehouse", storeCategoryNames: [], retainUnlistedVariantsInGroup: true, existingGroupKey: source.groupKey });
}

describe("existing eBay identity composition", () => {
  it.each([
    [401, "EBAY_AUTH_REQUIRED"], [403, "EBAY_PROVIDER_ACCESS_DENIED"], [429, "EBAY_PROVIDER_RATE_LIMITED"],
    [408, "EBAY_REGISTRATION_READ_FAILED"], [503, "EBAY_REGISTRATION_READ_FAILED"], [404, "EBAY_SYNC_PROVIDER_IDENTITY_INVALID"],
  ] as const)("classifies the real shared observer HTTP%s without treating it as a mapping mismatch", async (status, code) => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const remote = provider(source, cases[0].group);
    remote.get.mockResolvedValueOnce({ status, body: {} });
    await expect(resolveExistingEbayListingIdentity(source, remote.observer, candidates(source))).rejects.toMatchObject({ code });
    expect(remote.get).toHaveBeenCalledOnce();
  });
  it.each([
    ["EBAY_REGISTRATION_PROVIDER_READ_TIMEOUT", "EBAY_REGISTRATION_READ_TIMEOUT"],
    ["EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE", "EBAY_REGISTRATION_READ_FAILED"],
  ] as const)("translates the shared observation port's %s for retry policy", async (readCode, code) => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const observer = { observeExistingPublication: vi.fn().mockRejectedValue(Object.assign(new Error("bounded read failed"), { code: readCode })) };
    await expect(resolveExistingEbayListingIdentity(source, observer, candidates(source))).rejects.toMatchObject({ code });
  });
  it.each(cases)("preserves renamed Catalog identity for product $productId while observing and drafting exact existing provider resources", async fixture => {
    const rows = rowsFor(fixture);
    const before = structuredClone(rows);
    const source = captureExistingEbayListingIdentity(rows, account);
    expect(source.groupKey).toBeNull();
    expect(source.variants[0]).toMatchObject({ variantId: fixture.ids[0], catalogSku: `${fixture.catalogGroup}-${fixture.suffixes[0]}`,
      sku: `${fixture.group}-${fixture.suffixes[0]}`, externalSku: `${fixture.group}-${fixture.suffixes[0]}` });
    const remote = provider(source, fixture.group);
    const bound = await resolveExistingEbayListingIdentity(source, remote.observer, candidates(source));
    expect(bound.groupKey).toBe(fixture.group);
    const output = draft(bound, fixture.catalogGroup);
    expect(output.itemGroup?.groupKey).toBe(fixture.group);
    expect(output.itemGroup?.payload.variantSKUs).toEqual(bound.variants.map(member => member.sku));
    expect(output.inventoryItems.map(item => item.sku)).toEqual(bound.variants.map(member => member.sku));
    expect(output.offers.map(offer => offer.variantId)).toEqual(fixture.ids);
    expect(output.inventoryItems[0].payload.product.imageUrls).toEqual([`https://example.com/${fixture.ids[0]}.jpg`]);
    expect(remote.get.mock.calls.every(([request]) => !request.path.includes(fixture.catalogGroup))).toBe(true);
    expect(rows).toEqual(before);
    expect(source.groupKey).toBeNull();
  });

  it("does not invent a missing local external SKU or offer ID while binding exact provider identity", async () => {
    const rows = rowsFor().map(row => ({ ...row, variant_sku: row.external_sku! }));
    const source = captureExistingEbayListingIdentity(rows, account);
    const remote = provider(source, cases[0].group);
    source.variants[0].externalSku = null;
    source.variants[0].offerId = null;
    const bound = await resolveExistingEbayListingIdentity(source, remote.observer, candidates(source));
    expect(bound.variants[0]).toMatchObject({ externalSku: null, offerId: cases[0].offers[0] });
    expect(source.variants[0].offerId).toBeNull();
  });

  it("rejects a saved offer ID that now refers to a different offer", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const remote = provider(source, cases[0].group);
    remote.state.offerIds[0] = "different-offer";
    await expect(resolveExistingEbayListingIdentity(source, remote.observer, candidates(source))).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
  });

  it("rejects a different account even when listing and SKU strings match", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const remote = provider(source, cases[0].group);
    remote.state.accountId = "another-seller";
    await expect(resolveExistingEbayListingIdentity(source, remote.observer, candidates(source))).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
  });

  it("rejects unrepresented provider members rather than dropping them from a group write", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const remote = provider(source, cases[0].group, "UNMAPPED-SOLD-VARIANT");
    await expect(resolveExistingEbayListingIdentity(source, remote.observer, candidates(source))).rejects.toMatchObject({ code: "EBAY_SYNC_MEMBERSHIP_CHANGED" });
  });

  it("fails before provider reads when saved members disagree on listing identity", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    source.variants[1].listingId = "another-listing";
    const remote = provider(source, cases[0].group);
    await expect(resolveExistingEbayListingIdentity(source, remote.observer, candidates(source))).rejects.toMatchObject({ code: "EBAY_SYNC_LISTING_IDENTITY_REQUIRED" });
    expect(remote.get).not.toHaveBeenCalled();
  });

  it.each(["catalogSku", "sku", "externalSku", "offerId", "listingId"] as const)("fences a %s change while the worker observes the provider", field => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const current = structuredClone(source);
    current.variants[0][field] = "changed";
    expect(() => assertEbayListingSourceIdentityUnchanged(source, current)).toThrow(/mapping changed/);
  });

  it("accepts legacy snapshots without treating their catalog-derived group key as provider evidence", () => {
    const current = captureExistingEbayListingIdentity(rowsFor(), account);
    const legacy = structuredClone(current);
    legacy.groupKey = cases[0].catalogGroup;
    for (const member of legacy.variants) delete member.catalogSku;
    expect(() => assertEbayListingSourceIdentityUnchanged(legacy, current)).not.toThrow();
  });

  it("requires a fresh command when content inclusion changes during provider observation", () => {
    const source = captureExistingEbayListingIdentity(rowsFor(), account);
    const current = structuredClone(source);
    current.variants[0].contentSyncEnabled = false;
    expect(() => assertEbayListingSourceIdentityUnchanged(source, current)).toThrow(/mapping changed/);
  });

  it("supports a verified single item without a fabricated group and reads its photos by exact SKU", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor().slice(0, 1), account);
    const remote = provider(source, null);
    const bound = await resolveExistingEbayListingIdentity(source, remote.observer, candidates(source));
    expect(bound.groupKey).toBeNull();
    expect(draft(bound, cases[0].catalogGroup).itemGroup).toBeNull();
    const getInventoryItemGroup = vi.fn();
    const getInventoryItem = vi.fn(async (sku: string) => ({ sku, condition: "NEW" as const, availability: { shipToLocationAvailability: { quantity: 1 } }, product: { title: "Existing listing", imageUrls: ["https://example.com/item.jpg"] } }));
    const photos = await readExistingEbayListingPhotos({ getInventoryItemGroup, getInventoryItem }, { groupKey: null, variants: bound.variants });
    expect(photos.byVariantId.get(source.variants[0].variantId)).toEqual(["https://example.com/item.jpg"]);
    expect(getInventoryItemGroup).not.toHaveBeenCalled();
  });

  it("preserves a verified group that has one remaining member", async () => {
    const source = captureExistingEbayListingIdentity(rowsFor().slice(0, 1), account);
    const remote = provider(source, cases[0].group);
    const bound = await resolveExistingEbayListingIdentity(source, remote.observer, candidates(source));
    expect(draft(bound, cases[0].catalogGroup).itemGroup?.groupKey).toBe(cases[0].group);
  });

  it("rejects ambiguous, incomplete and cross-product source mappings", () => {
    expect(() => captureExistingEbayListingIdentity([], account)).toThrow(/incomplete/);
    expect(() => captureExistingEbayListingIdentity([...rowsFor(), ...rowsFor()], account)).toThrow(/duplicate/);
    expect(() => captureExistingEbayListingIdentity([...rowsFor(), ...rowsFor(cases[1])], account)).toThrow(/different products/);
    expect(() => captureExistingEbayListingIdentity([{ ...rowsFor()[0], variant_sku: null }], account)).toThrow(/incomplete/);
  });
});
