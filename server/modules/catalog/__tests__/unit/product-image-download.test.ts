import { describe, expect, it, vi } from "vitest";
import { downloadProductImage, MAX_PRODUCT_IMAGE_BYTES, validateProductImage } from "../../product-image-download.service";
import { reorderProductAssetsSchema, sortCatalogAssets } from "@shared/catalog/product-assets";

const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = { data, mimeType: "image/png" };
const source = { sku: 'PACK/100\r\n".jpg', url: "https://cdn.example.com/photo.png", ...image, fileBytes: data.length };

describe("catalog image downloads", () => {
  it("downloads stored bytes with a safe SKU filename without contacting a remote source", async () => {
    const read = vi.fn().mockResolvedValue(source), fetchImage = vi.fn();
    const result = await downloadProductImage(14, { read, fetchImage });
    expect(result).toEqual({ ...image, filename: "PACK-100----jpg-image-14.png" });
    expect(read).toHaveBeenCalledWith(14); expect(fetchImage).not.toHaveBeenCalled();
  });
  it("downloads the original URL when an image has no stored file", async () => {
    const fetchImage = vi.fn().mockResolvedValue(image);
    expect(await downloadProductImage(14, { read: async () => ({ ...source, data: null }), fetchImage })).toMatchObject(image);
    expect(fetchImage).toHaveBeenCalledWith(source.url);
  });
  it("distinguishes missing, oversized and invalid images", async () => {
    const fetchImage = vi.fn();
    await expect(downloadProductImage(14, { read: async () => null, fetchImage })).rejects.toMatchObject({ status: 404 });
    await expect(downloadProductImage(14, { read: async () => ({ ...source, data: null, url: null }), fetchImage })).rejects.toMatchObject({ status: 404 });
    await expect(downloadProductImage(14, { read: async () => ({ ...source, fileBytes: MAX_PRODUCT_IMAGE_BYTES + 1 }), fetchImage })).rejects.toMatchObject({ status: 413 });
    expect(() => validateProductImage({ data: Buffer.from("<html>not a photo</html>"), mimeType: "image/png" })).toThrow("did not return");
    expect(() => validateProductImage({ data: Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 1), mimeType: "image/png" })).toThrow("10 MB");
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it.each([
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0])], ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")], ["image/png", data],
  ])("accepts %s image signatures", (mimeType, data) => {
    expect(validateProductImage({ data, mimeType })).toEqual({ data, mimeType });
  });
});

describe("catalog image order boundary", () => {
  it.each([[1, 1], [0], [-1], [1.5], ["1"], [2147483648]])("rejects invalid IDs %j", (...orderedIds) => {
    expect(reorderProductAssetsSchema.safeParse({ orderedIds }).success).toBe(false);
  });
  it("preserves the legacy complete-order shape and validates snapshots", () => {
    expect(reorderProductAssetsSchema.parse({ orderedIds: [2, 1] })).toEqual({ orderedIds: [2, 1] });
    expect(reorderProductAssetsSchema.safeParse({ orderedIds: [1], expectedOrderedIds: [1, 1] }).success).toBe(false);
    expect(reorderProductAssetsSchema.safeParse({ orderedIds: [1], productId: 2 }).success).toBe(false);
  });
  it("orders tied positions deterministically without mutating catalog data", () => {
    const assets = [{ id: 3, position: 0 }, { id: 1, position: 0 }, { id: 2, position: 1 }];
    expect(sortCatalogAssets(assets).map(asset => asset.id)).toEqual([1, 3, 2]);
    expect(assets.map(asset => asset.id)).toEqual([3, 1, 2]);
  });
});
