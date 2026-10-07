import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { ChannelEbayListingPhotoResolver } from "../../ebay-listing-photos.service";
import { buildEbayListingPhotoPlan, ebayListingImagesFromUrls, EbayListingPhotoError } from "../../ebay-listing-photos.domain";
import { readExistingEbayListingPhotos } from "../../adapters/ebay/ebay-listing-photos.reader";
import { EbayApiRequestError, isMissingEbayInventoryResource } from "../../adapters/ebay/ebay-api-error";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";

const variants = [{ variantId: 10, sku: "PACK" }, { variantId: 11, sku: "CASE" }];
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });
const linked = { forProductVariantId: 10, id: 1, productId: 1, productVariantId: null, position: 0,
  url: "https://cdn.example.com/front.jpg", storageType: "url", mimeType: null, fileBytes: null, fileHash: null, fileHeader: null };
function fixture(options: { assetIds?: number[]; rows?: unknown[]; scope?: unknown; failRead?: boolean; failRollback?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.failRollback) throw new Error("rollback failed");
    if (sql.includes("FROM catalog.products WHERE id")) return { rows: [options.scope ?? { variants, assetIds: options.assetIds ?? [1] }] };
    if (sql.includes("FROM channels.channel_variant_overrides")) return { rows: [] };
    if (sql.includes("FROM channels.channel_asset_overrides")) return { rows: [] };
    if (sql.includes("WITH overrides")) {
      if (options.failRead) throw new Error("catalog read failed");
      return { rows: options.rows ?? [linked, { ...linked, forProductVariantId: 11 }] };
    }
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const resolver = new ChannelEbayListingPhotoResolver({ connect } as unknown as Pool, publicUrl);
  return { resolver, connect, query, release };
}
const request = { productId: 1, channelId: 67, variants };
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("one eBay photo projection", () => {
  it("preserves primary order, SKU scope, duplicate removal and the existing limit without mutating input", () => {
    const images = [
      { url: "https://cdn.example.com/case.jpg", variantSku: "CASE", position: 1, altText: null },
      { url: "https://cdn.example.com/foreign.jpg", variantSku: "OTHER", position: 0, altText: null },
      { url: "https://cdn.example.com/front.jpg", variantSku: null, position: 0, altText: null },
      { url: "https://cdn.example.com/pack.jpg", variantSku: "PACK", position: 1, altText: null },
      { url: "https://cdn.example.com/front.jpg", variantSku: "PACK", position: 2, altText: null },
      ...Array.from({ length: 15 }, (_, i) => ({ url: `https://cdn.example.com/${i}.jpg`, variantSku: null, position: i + 3, altText: null })),
    ];
    const before = structuredClone(images);
    const plan = buildEbayListingPhotoPlan(images, variants);
    expect(plan.byVariantId.get(10)?.slice(0, 2)).toEqual(["https://cdn.example.com/front.jpg", "https://cdn.example.com/pack.jpg"]);
    expect(plan.byVariantId.get(11)?.slice(0, 2)).toEqual(["https://cdn.example.com/front.jpg", "https://cdn.example.com/case.jpg"]);
    expect(plan.groupImageUrls.slice(0, 3)).toEqual(["https://cdn.example.com/front.jpg", "https://cdn.example.com/case.jpg", "https://cdn.example.com/pack.jpg"]);
    expect(plan.groupImageUrls).toHaveLength(12);
    expect([...plan.byVariantId.values()].every(urls => urls.length === 12)).toBe(true);
    expect(images).toEqual(before);
  });
  it.each(["http://cdn.example.com/a.jpg", "https://localhost/a.jpg", "https://127.0.0.1/a.jpg", "https://user:secret@cdn.example.com/a.jpg", " https://cdn.example.com/a.jpg"])
    ("refuses an unusable provider address %s", url => {
      expect(() => buildEbayListingPhotoPlan(ebayListingImagesFromUrls([url]), variants)).toThrow(EbayListingPhotoError);
    });
  it("refuses ambiguous size identity and invalid order metadata", () => {
    expect(() => buildEbayListingPhotoPlan([], [variants[0], variants[0]])).toThrow("unique catalog sizes");
    expect(() => buildEbayListingPhotoPlan([{ url: linked.url, position: -1, variantSku: null, altText: null }], variants)).toThrow("metadata");
  });
});

describe("eBay Catalog photo orchestration", () => {
  it("resolves once in a read-only snapshot and never consults stale provider pictures when Catalog has images", async () => {
    const { resolver, query, release } = fixture();
    const readExistingPhotos = vi.fn();
    const first = await resolver.resolve({ ...request, readExistingPhotos });
    const replay = await resolver.resolve({ ...request, readExistingPhotos });
    expect(replay).toEqual(first);
    expect(first.byVariantId.get(10)).toEqual([linked.url]);
    expect(query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledTimes(2);
    expect(readExistingPhotos).not.toHaveBeenCalled();
  });
  it.each([
    { ...request, variants: [{ variantId: 10, sku: "OTHER" }] },
    { ...request, variants: [{ variantId: 20, sku: "PACK" }] },
  ])("rejects a SKU or size mismatch and rolls back before provider access", async input => {
    const { resolver, query, release } = fixture();
    const readExistingPhotos = vi.fn();
    await expect(resolver.resolve({ ...input, readExistingPhotos })).rejects.toMatchObject({ code: "EBAY_PHOTO_SCOPE_INVALID" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    expect(readExistingPhotos).not.toHaveBeenCalled();
  });
  it("refuses a selected broken upload without substituting provider photos", async () => {
    const { resolver, query } = fixture({ rows: [{ ...linked, url: null, storageType: "file" }] });
    const readExistingPhotos = vi.fn();
    await expect(resolver.resolve({ ...request, readExistingPhotos })).rejects.toMatchObject({ code: "EBAY_CATALOG_PHOTO_UNAVAILABLE", context: { variantId: 10 } });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(readExistingPhotos).not.toHaveBeenCalled();
  });
  it("does not revive excluded or another SKU's images by falling back to eBay", async () => {
    const { resolver } = fixture({ rows: [] });
    const readExistingPhotos = vi.fn();
    await expect(resolver.resolve({ ...request, readExistingPhotos })).rejects.toMatchObject({ code: "EBAY_CATALOG_PHOTO_REQUIRED" });
    expect(readExistingPhotos).not.toHaveBeenCalled();
  });
  it("uses exact existing SKU and group photos only when Catalog genuinely has no image assets", async () => {
    const { resolver, release } = fixture({ assetIds: [] });
    const readExistingPhotos = vi.fn(async () => {
      expect(release).toHaveBeenCalledOnce();
      return { byVariantId: new Map([[10, ["https://i.ebayimg.com/pack.jpg"]], [11, []]]), groupImageUrls: ["https://i.ebayimg.com/group.jpg"] };
    });
    const plan = await resolver.resolve({ ...request, readExistingPhotos });
    expect(plan.byVariantId.get(10)).toEqual(["https://i.ebayimg.com/pack.jpg"]);
    expect(plan.byVariantId.get(11)).toEqual(["https://i.ebayimg.com/group.jpg"]);
    expect(plan.groupImageUrls).toEqual(["https://i.ebayimg.com/group.jpg"]);
  });
  it("preserves external photo order/count for a source lock without inspecting Catalog blobs", async () => {
    const { resolver, query } = fixture();
    const groupImageUrls = Array.from({ length: 15 }, (_, i) => `https://i.ebayimg.com/${i}.jpg`);
    const existing = { byVariantId: new Map([[10, []], [11, ["https://i.ebayimg.com/case.jpg"]]]), groupImageUrls };
    const plan = await resolver.resolve({ ...request, mode: "preserve", readExistingPhotos: async () => existing });
    expect(plan).toEqual(existing);
    expect(plan.groupImageUrls).toHaveLength(15);
    expect(query.mock.calls.some(([sql]) => sql.includes("WITH overrides"))).toBe(false);
    expect(plan).not.toBe(existing);
  });
  it("does not turn missing source-locked group pictures or a provider outage into an empty gallery", async () => {
    const { resolver } = fixture();
    await expect(resolver.resolve({ ...request, mode: "preserve", readExistingPhotos: async () => ({ byVariantId: new Map([[10, [linked.url]], [11, [linked.url]]]), groupImageUrls: [] }) }))
      .rejects.toMatchObject({ code: "EBAY_EXISTING_GROUP_PHOTOS_REQUIRED" });
    const error = new Error("provider unavailable");
    await expect(resolver.resolve({ ...request, mode: "preserve", readExistingPhotos: async () => { throw error; } })).rejects.toBe(error);
  });
  it("discards a connection whose read and rollback both fail", async () => {
    const { resolver, release } = fixture({ failRead: true, failRollback: true });
    await expect(resolver.resolve(request)).rejects.toThrow(AggregateError);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([{ ...request, productId: 0 }, { ...request, channelId: -1 }, { ...request, variants: [] }, { ...request, variants: [{ variantId: 10, sku: 1 }] }])
    ("validates the request before acquiring a connection", async input => {
      const { resolver, connect } = fixture();
      await expect(resolver.resolve(input as never)).rejects.toMatchObject({ code: "EBAY_PHOTO_SCOPE_INVALID" });
      expect(connect).not.toHaveBeenCalled();
    });
});

describe("existing eBay photo reads", () => {
  it("classifies actual not-found responses without masking auth failures containing numeric IDs", () => {
    expect(isMissingEbayInventoryResource(new EbayApiRequestError(404,"not found",""))).toBe(true);
    expect(isMissingEbayInventoryResource(new EbayApiRequestError(400,"resource missing",JSON.stringify({ errors:[{ errorId:25710 }] })))).toBe(true);
    expect(isMissingEbayInventoryResource(new EbayApiRequestError(401,"failed path/40425710",JSON.stringify({ errors:[{ errorId:25710 }] })))).toBe(false);
    expect(isMissingEbayInventoryResource(new Error("404 unknown transport failure"))).toBe(false);
  });
  it("rejects a provider response for another group or SKU before retaining any photos", async () => {
    const client = { getInventoryItemGroup: vi.fn(async () => ({ inventoryItemGroupKey: "OTHER", imageUrls: [linked.url] })),
      getInventoryItem: vi.fn(async () => ({ sku: "OTHER-SKU", product: { imageUrls: [linked.url] } })) };
    await expect(readExistingEbayListingPhotos(client as never, { groupKey: "PRODUCT", variants }))
      .rejects.toThrow("another listing group");
    expect(client.getInventoryItem).not.toHaveBeenCalled();
    client.getInventoryItemGroup.mockResolvedValue({ inventoryItemGroupKey: "PRODUCT", imageUrls: [linked.url] });
    await expect(readExistingEbayListingPhotos(client as never, { groupKey: "PRODUCT", variants }))
      .rejects.toThrow("another SKU");
  });

  it("keeps group and SKU galleries separate and reads every exact SKU", async () => {
    const client = { getInventoryItemGroup: vi.fn(async () => ({ imageUrls: ["https://i.ebayimg.com/group.jpg"] })),
      getInventoryItem: vi.fn(async (sku: string) => ({ sku, product: { imageUrls: sku === "PACK" ? ["https://i.ebayimg.com/pack.jpg"] : [] } })) };
    const plan = await readExistingEbayListingPhotos(client as never, { groupKey: "PRODUCT", variants });
    expect(client.getInventoryItem.mock.calls).toEqual([["PACK"], ["CASE"]]);
    expect(plan).toEqual({ byVariantId: new Map([[10, ["https://i.ebayimg.com/pack.jpg"]], [11, []]]), groupImageUrls: ["https://i.ebayimg.com/group.jpg"] });
  });
  it("never hides a failed group read", async () => {
    const error = new Error("eBay authorization failed");
    const client = { getInventoryItemGroup: vi.fn(async () => { throw error; }), getInventoryItem: vi.fn() };
    await expect(readExistingEbayListingPhotos(client, { groupKey: "PRODUCT", variants })).rejects.toBe(error);
    expect(client.getInventoryItem).not.toHaveBeenCalled();
  });
  it("uses the production API client GET with escaped group identity and no quantity admission", async () => {
    vi.stubEnv("DRY_RUN", "false");
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ imageUrls: ["https://i.ebayimg.com/group.jpg"] }));
    const quantityAdmission = vi.fn();
    const client = new EbayApiClient({ getAccessToken: async () => "test-token" }, 67, "sandbox", { request: fetch as typeof globalThis.fetch, quantityAdmission });
    await expect(client.getInventoryItemGroup("P/ A")).resolves.toMatchObject({ imageUrls: ["https://i.ebayimg.com/group.jpg"] });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item_group/P%2F%20A");
    expect(quantityAdmission).not.toHaveBeenCalled();
  });
});
