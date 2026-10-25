import { describe, expect, it, vi } from "vitest";
import { resolveEbayListingPackage, prepareEbayListingPackages, assertEbayPackagePreservation } from "../../adapters/ebay/ebay-listing-package";
import type { EbayInventoryItem } from "../../adapters/ebay/ebay-types";
import { EbayApiRequestError } from "../../adapters/ebay/ebay-api-error";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { syncProviderFixture, syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

const source = { productId: 20, variantId: 101, facts: { weightGrams: "120.25" },
  requirements: { weight: true, dimensions: true } };
const observed = { dimensions: { length: 6, width: 4, height: 1, unit: "INCH" as const },
  weight: { value: 2, unit: "POUND" as const }, packageType: "MAILING_BOX", shippingIrregular: true };
describe("eBay package transport", () => {
  async function maintenanceFixture() {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { ...source,
      requirements: { ...source.requirements, dimensionsOnMaintenance: "recommended" } };
    return { provider, prepared };
  }
  it("warns only after proving the exact published offer and unchanged fulfillment policy", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const result = await prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity);
    expect(result.inventoryItems[0].packagePlan?.warnings).toEqual([{ code: "CHANNEL_PACKAGE_DIMENSIONS_MISSING",
      field: "package_dimensions", productId: 20, variantId: 101, variantSku: "P5" }]);
    expect(result.inventoryItems[0].payload.packageWeightAndSize).toEqual({ weight: { value: 120.25, unit: "GRAM" } });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(provider.client.publishOffer).not.toHaveBeenCalled();
  });
  it("retains the publication requirement for a new or unproved listing", async () => {
    const { provider, prepared } = await maintenanceFixture();
    await expect(prepareEbayListingPackages(provider.client, prepared.draft)).rejects.toThrow(/length, width and height/);
    await expect(prepareEbayListingPackages(provider.client, prepared.draft,
      { ...syncIdentity, variants: syncIdentity.variants.map(member => ({ ...member, offerId: null })) })).rejects.toThrow(/length, width and height/);
  });
  it("does not reuse a maintenance warning when the same draft needs new publication", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity);
    provider.currentOffer().status = "UNPUBLISHED";
    provider.currentOffer().listingId = undefined;
    const beforeFirstMutation = vi.fn(async () => {});
    await expect(new EbayMarketplaceListingConnector().pushListing({ client: provider.client,
      draft: { ...draft, publishMode: "publish", hasExistingExternalIds: true }, beforeFirstMutation }))
      .rejects.toMatchObject({ code: "CHANNEL_LISTING_VALIDATION_FAILED" });
    expect(beforeFirstMutation).not.toHaveBeenCalled();
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
    expect(provider.client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
  it("retains required dimensions when the fulfillment policy changes", async () => {
    const { provider, prepared } = await maintenanceFixture();
    prepared.draft.offers[0].payload = { ...prepared.draft.offers[0].payload,
      listingPolicies: { ...prepared.draft.offers[0].payload.listingPolicies, fulfillmentPolicyId: "different-policy" } };
    await expect(prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity)).rejects.toThrow(/length, width and height/);
  });
  it("does not relax validation for a different or unpublished offer", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const offers = await provider.client.getOffers("P5", "EBAY_US");
    for (const offer of [{ ...offers.offers[0], status: "UNPUBLISHED" }, { ...offers.offers[0], listingId: "another-listing" }]) {
      vi.mocked(provider.client.getOffers).mockResolvedValueOnce({ offers: [offer] });
      await expect(prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity))
        .rejects.toMatchObject({ code: "EBAY_SYNC_OFFER_IDENTITY_CHANGED" });
    }
  });
  it("reads an exact offer when its collection response omits the policy", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const offer = (await provider.client.getOffers("P5", "EBAY_US")).offers[0];
    const { listingPolicies: _policy, ...withoutPolicy } = offer;
    vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [withoutPolicy as typeof offer] });
    const getOffer = vi.fn(async () => offer);
    const result = await prepareEbayListingPackages({ ...provider.client, getOffer }, prepared.draft, syncIdentity);
    expect(getOffer).toHaveBeenCalledExactlyOnceWith("offer-101");
    expect(result.inventoryItems[0].packagePlan?.warnings).toHaveLength(1);
  });
  it("keeps policy-read failures before every mutation", async () => {
    const { provider, prepared } = await maintenanceFixture();
    vi.mocked(provider.client.getOffers).mockRejectedValueOnce(new Error("provider read failed"));
    await expect(prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity)).rejects.toThrow("provider read failed");
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it.each([429, 503, 403])("preserves typed HTTP %i policy read failures without allowing writes", async status => {
    const { provider, prepared } = await maintenanceFixture();
    const original = new EbayApiRequestError(status, "Provider refused the read", "{}");
    vi.mocked(provider.client.getOffers).mockRejectedValueOnce(original);
    await expect(prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity)).rejects.toMatchObject({ cause: original,
      context: { providerRead: { resource: "offer_shipping_policy", httpStatus: status, kind: status === 403 ? "refused" : "unavailable" } } });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("rechecks the proved maintenance shipping policy before a write", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity);
    provider.currentOffer().listingPolicies.fulfillmentPolicyId = "concurrent-policy-edit";
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems))
      .rejects.toMatchObject({ code: "EBAY_SYNC_PACKAGE_CHANGED" });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("reuses the owning sync's freshly resolved offer reads for its pre-write check", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity);
    const current = await provider.client.getOffers("P5", "EBAY_US");
    vi.mocked(provider.client.getOffers).mockClear();
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems, new Map([["P5", current]]))).resolves.toBeUndefined();
    expect(provider.client.getOffers).not.toHaveBeenCalled();
  });
  it("uses policy evidence from an exact sibling of the same published listing and fences it before writing", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const primary = (await provider.client.getOffers("P5", "EBAY_US")).offers[0];
    const { listingPolicies: _policy, ...withoutPolicy } = primary;
    const peer = { ...primary, sku: "CASE", offerId: "offer-102" };
    vi.mocked(provider.client.getOffers).mockImplementation(async sku => ({ offers: [sku === "CASE" ? peer : withoutPolicy as typeof primary] }));
    const maintenance = { ...syncIdentity, variants: [...syncIdentity.variants,
      { variantId: 102, sku: "CASE", offerId: "offer-102", listingId: "listing-20" }] };
    const result = await prepareEbayListingPackages(provider.client, prepared.draft, maintenance);
    expect(result.inventoryItems[0].packagePlan?.warnings).toHaveLength(1);
    await expect(assertEbayPackagePreservation(provider.client, result.inventoryItems)).resolves.toBeUndefined();
    peer.listingId = "different-listing";
    await expect(assertEbayPackagePreservation(provider.client, result.inventoryItems))
      .rejects.toMatchObject({ code: "EBAY_SYNC_OFFER_IDENTITY_CHANGED" });
  });
  it("does not use a different listing or local desired settings to fill an omitted policy", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const primary = (await provider.client.getOffers("P5", "EBAY_US")).offers[0];
    const { listingPolicies: _policy, ...withoutPolicy } = primary;
    vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [withoutPolicy as typeof primary] });
    await expect(prepareEbayListingPackages(provider.client, prepared.draft, { ...syncIdentity, variants: [...syncIdentity.variants,
      { variantId: 102, sku: "CASE", offerId: "offer-102", listingId: "different-listing" }] }))
      .rejects.toMatchObject({ context: { providerRead: { resource: "offer_shipping_policy", kind: "invalid_response" } } });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("refuses multiple published listings for a SKU instead of treating one match as sufficient", async () => {
    const { provider, prepared } = await maintenanceFixture();
    const offer = (await provider.client.getOffers("P5", "EBAY_US")).offers[0];
    vi.mocked(provider.client.getOffers).mockResolvedValue({ offers: [offer,
      { ...offer, offerId: "second-offer", listingId: "second-listing" }] });
    await expect(prepareEbayListingPackages(provider.client, prepared.draft, syncIdentity))
      .rejects.toMatchObject({ code: "EBAY_SYNC_OFFER_IDENTITY_CHANGED" });
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
    expect(() => resolveEbayListingPackage({ source, sku: "P5" })).toThrow(/length, width and height/);
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
