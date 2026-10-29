import { describe, expect, it, vi } from "vitest";
import { resolveEbayListingPackage, prepareEbayListingPackages, assertEbayPackagePreservation } from "../../adapters/ebay/ebay-listing-package";
import type { EbayInventoryItem } from "../../adapters/ebay/ebay-types";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const source = { productId: 20, variantId: 101, facts: { weightGrams: "120.25" },
  requirements: { weight: true, dimensions: "recommended" as const } };
const observed = { dimensions: { length: 6, width: 4, height: 1, unit: "INCH" as const },
  weight: { value: 2, unit: "POUND" as const }, packageType: "MAILING_BOX", shippingIrregular: true };
describe("eBay package transport", () => {
  it.each(["new", "published", "policy-change"] as const)("warns for %s packages without offer-policy reads", async shape => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = source;
    if (shape === "new") delete provider.currentItem().packageWeightAndSize;
    if (shape === "policy-change") prepared.draft.offers[0].payload.listingPolicies.fulfillmentPolicyId = "new-shipping";
    vi.mocked(provider.client.getOffers).mockClear();
    const getOffer = vi.fn(async () => { throw new Error("Package warning must not depend on a policy read"); });
    const client = { ...provider.client, getOffer };
    const draft = await prepareEbayListingPackages(client, prepared.draft);
    expect(draft.inventoryItems[0].packagePlan?.warnings).toEqual([{ code: "CHANNEL_PACKAGE_DIMENSIONS_MISSING",
      field: "package_dimensions", productId: 20, variantId: 101, variantSku: "P5" }]);
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ weight: { value: 120.25, unit: "GRAM" } });
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
    expect(provider.client.getOffers).not.toHaveBeenCalled();
    expect(getOffer).not.toHaveBeenCalled();
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("does not restore a stricter requirement when a prepared update becomes a publication", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = source;
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    provider.currentOffer().status = "UNPUBLISHED";
    provider.currentOffer().listingId = undefined;
    vi.mocked(provider.client.publishOfferByInventoryItemGroup).mockResolvedValue({ listingId: "listing-20" });
    const result = await new EbayMarketplaceListingConnector().pushListing({ client: provider.client,
      draft: { ...draft, publishMode: "publish", hasExistingExternalIds: true } });
    expect(result).toMatchObject({ published: true, externalProductId: "listing-20", warnings: [{ variantSku: "P5" }] });
    expect(provider.client.publishOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);
  });
  it("retires an old maintenance proof on fresh preparation without mutating the historical draft", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    const historical = { marketplaceId: "EBAY_US", variantId: 101, sku: "P5", offerId: "offer-101",
      listingId: "listing-20", fulfillmentPolicyId: "old-policy", relatedMembers: [] };
    prepared.draft.inventoryItems[0].packageMaintenance = historical;
    prepared.draft.inventoryItems[0].packageSource = source;
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0]).not.toHaveProperty("packageMaintenance");
    expect(prepared.draft.inventoryItems[0].packageMaintenance).toEqual(historical);
    expect(draft.inventoryItems[0].packagePlan?.warnings).toHaveLength(1);
  });
  it("preserves provider type, dimensions, units and irregular flag while replacing only known weight", () => {
    const result = resolveEbayListingPackage({ source, sku: "P5", observed });
    expect(result.payload).toEqual({ ...observed, weight: { value: 120.25, unit: "GRAM" } });
    expect(result.plan.sources).toEqual({ weight: "catalog", dimensions: "channel" });
    expect(observed.weight).toEqual({ value: 2, unit: "POUND" });
  });
  it("translates complete catalog dimensions without replacing provider-owned package type", () => {
    expect(resolveEbayListingPackage({ source: { ...source, facts: { ...source.facts, lengthMm: "152.40", widthMm: "101.60",
      heightMm: "25.40" } }, sku: "P5", observed }).payload).toEqual({
        ...observed, weight: { value: 120.25, unit: "GRAM" }, dimensions: { length: 15.24, width: 10.16, height: 2.54, unit: "CENTIMETER" },
        packageType: "MAILING_BOX" });
  });
  it("does not fabricate package type or dimensions for a new item", () => {
    const missing = resolveEbayListingPackage({ source, sku: "P5" });
    expect(missing.payload).toEqual({ weight: { value: 120.25, unit: "GRAM" } });
    expect(missing.plan.warnings).toHaveLength(1);
    const result = resolveEbayListingPackage({ source, sku: "P5", observed: { dimensions: observed.dimensions } });
    expect(result.payload).toEqual({ dimensions: observed.dimensions, weight: { value: 120.25, unit: "GRAM" } });
    expect(result.payload).not.toHaveProperty("packageType");
  });
  it("ignores a retired catalog type in old snapshots and never overwrites the observed provider type", () => {
    const legacySource = { ...source, facts: { ...source.facts, shippingPackageType: "letter" },
      requirements: { ...source.requirements, packageType: true } };
    expect(resolveEbayListingPackage({ source: legacySource, sku: "P5", observed }).payload.packageType).toBe("MAILING_BOX");
    expect(resolveEbayListingPackage({ source: legacySource, sku: "P5", observed: { dimensions: observed.dimensions } }).payload)
      .not.toHaveProperty("packageType");
  });
  it("refuses malformed preserved data but allows complete catalog facts to repair that field", () => {
    const malformed = { ...observed, weight: { value: 0, unit: "GRAM" as const } };
    expect(() => resolveEbayListingPackage({ source: { ...source, facts: {} }, sku: "P5", observed: malformed })).toThrow(/invalid package data/);
    expect(resolveEbayListingPackage({ source, sku: "P5", observed: malformed }).payload.weight?.value).toBe(120.25);
  });
  it("preserves unknown provider extension fields", () => {
    const extended = { ...observed, providerExtension: { handling: "fragile" } };
    expect(resolveEbayListingPackage({ source, sku: "P5", observed: extended }).payload).toMatchObject({ providerExtension: { handling: "fragile" } });
  });
  it("preserves provider flags when an older draft contains a default irregular flag", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    provider.currentItem().packageWeightAndSize = structuredClone(observed);
    prepared.draft.inventoryItems[0].payload.packageWeightAndSize = { weight: { value: 120.25, unit: "GRAM" }, packageType: "LETTER", shippingIrregular: false };
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ ...observed, weight: { value: 120.25, unit: "GRAM" } });
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
  });
  it("does not replay a legacy type-only container when the provider has no package data", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    delete provider.currentItem().packageWeightAndSize;
    prepared.draft.inventoryItems[0].payload.packageWeightAndSize = { packageType: "LETTER" };
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload).not.toHaveProperty("packageWeightAndSize");
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
  });
  it("detects edits to preserved fields before writes and permits edits to catalog-owned fields", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    provider.currentItem().packageWeightAndSize = structuredClone(observed);
    prepared.draft.inventoryItems[0].packageSource = source;
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    provider.currentItem().packageWeightAndSize!.weight = { value: 3, unit: "POUND" };
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
    provider.currentItem().packageWeightAndSize!.packageType = "LETTER";
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).rejects.toMatchObject({ code: "EBAY_SYNC_PACKAGE_CHANGED" });
    provider.currentItem().packageWeightAndSize!.packageType = "MAILING_BOX";
    provider.currentItem().packageWeightAndSize!.dimensions!.length = 9;
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).rejects.toMatchObject({ code: "EBAY_SYNC_PACKAGE_CHANGED" });
  });
  it("does not send any mutation when a later member read fails", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    const draft = { ...prepared.draft, inventoryItems: [...prepared.draft.inventoryItems, { ...prepared.draft.inventoryItems[0], sku: "LATER" }],
      offers: [...prepared.draft.offers, { ...prepared.draft.offers[0], variantId: 102, sku: "LATER", payload: { ...prepared.draft.offers[0].payload, sku: "LATER" } }],
      publishMode: "stage" as const, hasExistingExternalIds: false };
    vi.mocked(provider.client.getInventoryItem).mockImplementation(async sku => {
      if (sku === "LATER") throw Object.assign(new Error("read timeout"), { code: "ETIMEDOUT" });
      return { ...provider.currentItem(), sku } as EbayInventoryItem;
    });
    vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [] });
    await expect(new EbayMarketplaceListingConnector().pushListing({ client: provider.client, draft })).rejects.toThrow("read timeout");
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
  });
});
