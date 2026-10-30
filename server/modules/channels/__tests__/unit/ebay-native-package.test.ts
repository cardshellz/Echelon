import { describe, expect, it, vi } from "vitest";
import { readEbayNativePackage } from "../../adapters/ebay/ebay-native-package.reader";
import { prepareEbayListingPackages, assertEbayPackagePreservation, readEbayPackageVerificationView } from "../../adapters/ebay/ebay-listing-package";
import { providerReadDiagnosticFromError } from "@shared/channel-provider-read";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";
import { EBAY_US_STANDARD_PACKAGE_TYPE, ebayPreparedPackageTypeSchema } from "../../adapters/ebay/ebay-package-classification";

const offer = { sku: "BOX-P5", offerId: "offer-1", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "PUBLISHED", listing: { listingId: "298000000001" } };
const xml = (value = "PackageThickEnvelope", sku = "BOX-P5") => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>298000000001</ItemID><SKU>${sku}</SKU>${value ? `<ShippingPackageDetails><ShippingPackage>${value}</ShippingPackage></ShippingPackageDetails>` : ""}</Item></GetItemResponse>`;
const input = (request: typeof fetch) => ({ sku: "BOX-P5", marketplaceId: "EBAY_US", offers: [offer], accessToken: "test", environment: "sandbox" as const, request });

describe("eBay native package read and preservation", () => {
  it.each([["Letter", "LETTER"], ["LargeEnvelope", "LARGE_ENVELOPE"], ["PackageThickEnvelope", "PACKAGE_THICK_ENVELOPE"], ["USPSLargePack", "USPS_LARGE_PACK"]])("translates the actual native %s value", async (native, expected) => {
    const request = vi.fn<typeof fetch>(async () => new Response(xml(native)));
    expect(await readEbayNativePackage(input(request))).toEqual({ listingId: "298000000001", packageType: expected });
    expect(request.mock.calls[0][0]).toBe("https://api.sandbox.ebay.com/ws/api.dll");
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ "X-EBAY-API-CALL-NAME": "GetItem" });
    expect(request.mock.calls[0][1]?.body).toContain("<OutputSelector>ShippingPackageDetails</OutputSelector>");
    expect(request.mock.calls[0][1]?.body).toContain("<OutputSelector>ShippingDetails</OutputSelector>");
  });
  it("does not invent a classification when the exact listing has none", async () => {
    expect(await readEbayNativePackage(input(vi.fn(async () => new Response(xml("")))))).toEqual({ listingId: "298000000001", packageType: null });
  });
  it.each(["BOX&amp;P5", "BOX&#38;P5", "BOX&#x26;P5"])("binds the XML-encoded SKU %s to its exact JSON identity", async encodedSku => {
    const request = vi.fn(async () => new Response(xml("PackageThickEnvelope", encodedSku)));
    expect(await readEbayNativePackage({ ...input(request), sku: "BOX&P5", offers: [{ ...offer, sku: "BOX&P5" }] }))
      .toEqual({ listingId: "298000000001", packageType: "PACKAGE_THICK_ENVELOPE" });
  });
  it("accepts an empty optional variation container only when the root SKU binds exactly", async () => {
    const request = vi.fn(async () => new Response(xml().replace("<Item>", "<Item><Variations/>")));
    expect(await readEbayNativePackage(input(request))).toEqual({ listingId: "298000000001", packageType: "PACKAGE_THICK_ENVELOPE" });
  });
  it("does not recursively decode a literal entity-looking SKU into another identity", async () => {
    const request = vi.fn(async () => new Response(xml("PackageThickEnvelope", "BOX&amp;amp;P5")));
    expect(await readEbayNativePackage({ ...input(request), sku: "BOX&amp;P5", offers: [{ ...offer, sku: "BOX&amp;P5" }] }))
      .toEqual({ listingId: "298000000001", packageType: "PACKAGE_THICK_ENVELOPE" });
  });
  it("accepts empty optional XML parents and binds a variation SKU rather than its parent SKU", async () => {
    const body = `<GetItemResponse><Ack>Success</Ack><Item><ItemID>298000000001</ItemID><ShippingDetails/><SKU>BOX</SKU>
      <Variations><Variation><SKU>BOX-P5</SKU></Variation><Variation><SKU>BOX-C25</SKU></Variation></Variations></Item></GetItemResponse>`;
    expect(await readEbayNativePackage(input(vi.fn(async () => new Response(body)))))
      .toEqual({ listingId: "298000000001", packageType: null });
  });
  it.each([["SystemError", "unavailable"], ["RequestError", "refused"]])("preserves an XML %s failure as a failed read", async (classification, kind) => {
    const body = `<GetItemResponse><Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><ErrorClassification>${classification}</ErrorClassification></Errors></GetItemResponse>`;
    const error = await readEbayNativePackage(input(vi.fn(async () => new Response(body)))).catch(error => error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ method: "POST", kind, httpStatus: 200 });
  });
  it("does not read another listing for an unpublished offer", async () => {
    const request = vi.fn<typeof fetch>();
    expect(await readEbayNativePackage({ ...input(request), offers: [{ ...offer, status: "UNPUBLISHED", listing: undefined }] }))
      .toEqual({ listingId: null, packageType: null });
    expect(request).not.toHaveBeenCalled();
  });
  it("uses verified unpublished discovery for a missing item's ordinary class without another offer lookup", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101,
      facts: { weightGrams: "120.25" }, requirements: { weight: true, dimensions: "recommended" } };
    vi.mocked(provider.client.getInventoryItem).mockResolvedValue(null);
    provider.client.getListingPackageType = vi.fn(async () => ({ listingId: null, packageType: null }));
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft, new Map([["P5", []]]));
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ weight: { value: 5, unit: "OUNCE" }, packageType: EBAY_US_STANDARD_PACKAGE_TYPE });
    expect(draft.inventoryItems[0].packageTypeProof).toMatchObject({ source: "marketplace_default", listingId: null, observedPackageType: null });
    expect(provider.client.getListingPackageType).toHaveBeenCalledExactlyOnceWith("P5", "EBAY_US", []);
  });
  it("defaults only a verified missing US class and preserves every catalog measurement", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    const facts = { weightGrams: "120.25" };
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101, facts,
      requirements: { weight: true, dimensions: "recommended" } };
    provider.client.getListingPackageType = vi.fn(async () => ({ listingId: "listing-20", packageType: null }));
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ weight: { value: 5, unit: "OUNCE" }, packageType: EBAY_US_STANDARD_PACKAGE_TYPE });
    expect(draft.inventoryItems[0].packageTypeProof).toMatchObject({ source: "marketplace_default", observedPackageType: null, listingId: "listing-20" });
    expect(facts).toEqual({ weightGrams: "120.25" });
    expect(draft.inventoryItems[0].packagePlan?.warnings).toHaveLength(1);
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
    provider.currentItem().packageWeightAndSize = { packageType: EBAY_US_STANDARD_PACKAGE_TYPE };
    vi.mocked(provider.client.getListingPackageType).mockResolvedValue({ listingId: "listing-20", packageType: EBAY_US_STANDARD_PACKAGE_TYPE });
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
    vi.mocked(provider.client.getListingPackageType).mockResolvedValue({ listingId: "listing-20", packageType: "LETTER" });
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).rejects.toMatchObject({ code: "EBAY_SYNC_PACKAGE_CHANGED" });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("preserves an Inventory classification and leaves other marketplaces outside the US default", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101,
      facts: { weightGrams: "120.25" }, requirements: { weight: true, dimensions: false } };
    provider.client.getListingPackageType = vi.fn(async () => { throw new Error("Classification already present or outside US"); });
    provider.currentItem().packageWeightAndSize = { packageType: "LETTER" };
    const preserved = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(preserved.inventoryItems[0].payload.packageWeightAndSize?.packageType).toBe("LETTER");
    delete provider.currentItem().packageWeightAndSize;
    const other = await prepareEbayListingPackages(provider.client, { ...prepared.draft, marketplaceId: "EBAY_GB" });
    expect(other.inventoryItems[0].payload.packageWeightAndSize).not.toHaveProperty("packageType");
    expect(provider.client.getListingPackageType).not.toHaveBeenCalled();
  });
  it("never turns a failed native read into permission to use the default", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101,
      facts: { weightGrams: "120.25" }, requirements: { weight: true, dimensions: false } };
    provider.client.getListingPackageType = vi.fn(async () => { throw new Error("Read unavailable"); });
    await expect(prepareEbayListingPackages(provider.client, prepared.draft)).rejects.toThrow("Read unavailable");
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(ebayPreparedPackageTypeSchema.safeParse({ sku: "P5", marketplaceId: "EBAY_US", listingId: null,
      source: "marketplace_default", observedPackageType: null, packageType: "LETTER" }).success).toBe(false);
  });
  it("does not attach parcel metadata to an item without physical package values", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101,
      facts: {}, requirements: { weight: false, dimensions: false } };
    provider.client.getListingPackageType = vi.fn(async () => { throw new Error("No physical package"); });
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload).not.toHaveProperty("packageWeightAndSize");
    expect(provider.client.getListingPackageType).not.toHaveBeenCalled();
  });
  it.each([xml("Letter", "ANOTHER-SKU"), xml("toString"), "<bad", '<!DOCTYPE x [<!ENTITY x "a">]>'+xml(), xml().replace("298000000001", "298000000002")])("rejects unbound or invalid responses", async body => {
    await expect(readEbayNativePackage(input(vi.fn(async () => new Response(body))))).rejects.toMatchObject({ code: "EBAY_PACKAGE_READ_INVALID" });
  });
  it.each([401, 429, 503])("preserves HTTP %i as a failed POST read", async status => {
    const error = await readEbayNativePackage(input(vi.fn(async () => new Response("", { status })))).catch(error => error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ method: "POST", httpStatus: status,
      kind: status === 401 ? "refused" : "unavailable" });
    if (status === 401) expect(error.code).toBe("EBAY_AUTH_REQUIRED");
  });
  it("rejects an oversized native response before accepting package evidence", async () => {
    const error = await readEbayNativePackage(input(vi.fn(async () => new Response(xml() + " ".repeat(256_000))))).catch(error => error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ method: "POST", kind: "invalid_response" });
  });
  it("keeps transport failures as unavailable reads", async () => {
    const error = await readEbayNativePackage(input(vi.fn(async () => { throw new TypeError("network failed"); }))).catch(error => error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ method: "POST", kind: "unavailable" });
  });
  it("prepares a verified native type without copying listing dimensions and rejects a concurrent change", async () => {
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId: 101,
      facts: { weightGrams: "120.25" }, requirements: { weight: true, dimensions: "recommended" } };
    let native = { listingId: "listing-20", packageType: "LETTER" };
    provider.client.getListingPackageType = vi.fn(async () => ({ ...native }));
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    expect(draft.inventoryItems[0].payload.packageWeightAndSize).toEqual({ weight: { value: 5, unit: "OUNCE" }, packageType: "LETTER" });
    expect(draft.inventoryItems[0].packagePlan?.warnings).toHaveLength(1);
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).resolves.toBeUndefined();
    native = { ...native, packageType: "USPS_LARGE_PACK" };
    await expect(assertEbayPackagePreservation(provider.client, draft.inventoryItems)).rejects.toMatchObject({ code: "EBAY_SYNC_PACKAGE_CHANGED" });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    const view = await readEbayPackageVerificationView(provider.client, draft.inventoryItems[0], provider.currentItem(), "EBAY_US");
    expect(view.packageWeightAndSize).toEqual({ packageType: "USPS_LARGE_PACK" });
    expect(provider.currentItem().packageWeightAndSize).toBeUndefined();
  });
});
