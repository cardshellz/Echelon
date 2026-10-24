import { describe, expect, it, vi } from "vitest";
import { resolveEbayListingPackage, prepareEbayListingPackages, assertEbayPackagePreservation } from "../../adapters/ebay/ebay-listing-package";
import type { EbayInventoryItem } from "../../adapters/ebay/ebay-types";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const source = { productId: 20, variantId: 101, facts: { weightGrams: "120.25" },
  requirements: { weight: true, dimensions: true, packageType: true } };
const observed = { dimensions: { length: 6, width: 4, height: 1, unit: "INCH" as const },
  weight: { value: 2, unit: "POUND" as const }, packageType: "MAILING_BOX", shippingIrregular: true };
describe("eBay package transport", () => {
  it("preserves provider type, dimensions, units and irregular flag while replacing only known weight", () => {
    const result = resolveEbayListingPackage({ source, sku: "P5", observed });
    expect(result.payload).toEqual({ ...observed, weight: { value: 120.25, unit: "GRAM" } });
    expect(result.plan.sources).toEqual({ weight: "catalog", dimensions: "channel", packageType: "channel" });
    expect(observed.weight).toEqual({ value: 2, unit: "POUND" });
  });
  it("translates complete catalog dimensions and type, without rounding away real measurements", () => {
    expect(resolveEbayListingPackage({ source: { ...source, facts: { ...source.facts, lengthMm: "152.40", widthMm: "101.60",
      heightMm: "25.40", shippingPackageType: "parcel" } }, sku: "P5", observed }).payload).toEqual({
        ...observed, weight: { value: 120.25, unit: "GRAM" }, dimensions: { length: 15.24, width: 10.16, height: 2.54, unit: "CENTIMETER" },
        packageType: "PACKAGE_THICK_ENVELOPE" });
  });
  it("does not fabricate package type or dimensions for a new item", () => {
    expect(() => resolveEbayListingPackage({ source, sku: "P5" })).toThrow(/length, width and height/);
    expect(() => resolveEbayListingPackage({ source, sku: "P5", observed: { dimensions: observed.dimensions } })).toThrow(/package type/);
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
    prepared.draft.inventoryItems[0].payload.packageWeightAndSize = { weight: { value: 120.25, unit: "GRAM" }, shippingIrregular: false };
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ ...observed, weight: { value: 120.25, unit: "GRAM" } });
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
  });
  it("detects edits to preserved fields before writes and permits edits to catalog-owned fields", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    provider.currentItem().packageWeightAndSize = structuredClone(observed);
    prepared.draft.inventoryItems[0].packageSource = source;
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    provider.currentItem().packageWeightAndSize!.weight = { value: 3, unit: "POUND" };
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
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
    await expect(new EbayMarketplaceListingConnector().pushListing({ client: provider.client, draft })).rejects.toThrow("read timeout");
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
  });
});
