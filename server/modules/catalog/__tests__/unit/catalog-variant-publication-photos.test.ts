import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import {
  PgCatalogVariantPublicationPhotoReader,
  readCatalogVariantPublicationImages,
  resolveCatalogPublicationImages,
  resolveCatalogPublicationPhotos,
  type CatalogPublicationImage,
} from "../../catalog-publication-images.reader";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../product-image-download.service";

const hash = "ab".repeat(32);
const pngHeader = Buffer.from("89504e470d0a1a0a00000000", "hex");
const uploaded: CatalogPublicationImage = {
  id: 42, productId: 10, productVariantId: null, position: 1,
  url: null, storageType: "file", fileBytes: 100, fileHash: hash, fileHeader: pngHeader, mimeType: "image/png",
};
const linked: CatalogPublicationImage = {
  id: 7, productId: 10, productVariantId: 70, position: 0,
  url: "https://cdn.example.com/front.jpg", storageType: "url", fileBytes: null, fileHash: null, fileHeader: null, mimeType: null,
};
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });

function queryReturning(rows: Array<CatalogPublicationImage & { forProductVariantId: number }>) {
  return vi.fn(async (_sql: string, _params: unknown[]) => ({ rows }));
}

describe("resolveCatalogPublicationPhotos", () => {
  it("keeps listing order and says which photos are uploaded files", () => {
    expect(resolveCatalogPublicationPhotos([uploaded, linked], publicUrl)).toEqual({
      photos: [
        { assetId: 42, url: `https://catalog.example.com/api/catalog/images/42/${hash}.png`, position: 1, uploaded: true },
        { assetId: 7, url: "https://cdn.example.com/front.jpg", position: 0, uploaded: false },
      ],
      issues: [],
    });
  });

  it("reports an uploaded photo it cannot publish and keeps the others", () => {
    const resolved = resolveCatalogPublicationPhotos([uploaded, { ...uploaded, id: 43, fileBytes: null }, linked],
      createCatalogPublicImageUrl({}));
    expect(resolved.photos).toEqual([{ assetId: 7, url: "https://cdn.example.com/front.jpg", position: 0, uploaded: false }]);
    expect(resolved.issues).toEqual([
      expect.objectContaining({ assetId: 42, code: "CATALOG_PUBLIC_URL_REQUIRED" }),
      expect.objectContaining({ assetId: 43, code: "CATALOG_IMAGE_UNAVAILABLE" }),
    ]);
  });

  it("leaves the URL-only result unchanged for existing callers", () => {
    expect(resolveCatalogPublicationImages([uploaded, linked], publicUrl)).toEqual({
      images: [`https://catalog.example.com/api/catalog/images/42/${hash}.png`, "https://cdn.example.com/front.jpg"],
      issues: [],
    });
  });
});

describe("readCatalogVariantPublicationImages", () => {
  it("reads each size's photos in one query, primary first, limited, with the size's own photos", async () => {
    const query = queryReturning([
      { forProductVariantId: 70, ...uploaded },
      { forProductVariantId: 70, ...linked },
      { forProductVariantId: 71, ...uploaded },
    ]);
    const images = await readCatalogVariantPublicationImages({ query } as never, { productVariantIds: [70, 71, 72, 70], maxPhotosPerVariant: 20 });
    expect([...images.keys()]).toEqual([70, 71, 72]);
    expect(images.get(70)).toEqual([uploaded, linked]);
    expect(images.get(71)).toEqual([uploaded]);
    expect(images.get(72)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([[70, 71, 72], 20, MAX_PRODUCT_IMAGE_BYTES, "[]", null]);
    expect(sql).toContain("ORDER BY pa.product_id, pa.is_primary DESC, COALESCE(o.position_override, pa.position) ASC, pa.id ASC");
    expect(sql).toContain("candidates.product_variant_id IS NULL OR candidates.product_variant_id = pv.id");
    expect(sql).toContain("pa.asset_type = 'image'");
    expect(sql).toContain("COALESCE(o.url_override, NULLIF(BTRIM(pa.url), '')) IS NOT NULL OR pa.storage_type IN ('file', 'both')");
    expect(sql).toContain("WHERE photo_rank <= $2");
    // The fingerprint is computed per photo, not per size, and only for kept photos.
    expect(sql).toMatch(/photos AS MATERIALIZED \([\s\S]*encode\(sha256\(pa\.file_data\), 'hex'\)[\s\S]*WHERE pa\.id IN \(SELECT asset_id FROM kept\)/);
  });

  it("does not query for no sizes", async () => {
    const query = queryReturning([]);
    await expect(readCatalogVariantPublicationImages({ query } as never, { productVariantIds: [], maxPhotosPerVariant: 20 }))
      .resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { productVariantIds: [0], maxPhotosPerVariant: 20 },
    { productVariantIds: [-1], maxPhotosPerVariant: 20 },
    { productVariantIds: [1.5], maxPhotosPerVariant: 20 },
    { productVariantIds: [2_147_483_648], maxPhotosPerVariant: 20 },
    { productVariantIds: [70], maxPhotosPerVariant: 0 },
    { productVariantIds: [70], maxPhotosPerVariant: 2.5 },
    { productVariantIds: [70], maxPhotosPerVariant: Number.POSITIVE_INFINITY },
  ])("refuses invalid input %j before querying", async (input) => {
    const query = queryReturning([]);
    await expect(readCatalogVariantPublicationImages({ query } as never, input))
      .rejects.toMatchObject({ code: "CATALOG_IMAGE_READ_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("PgCatalogVariantPublicationPhotoReader", () => {
  it("resolves each size's photos to marketplace URLs and reports the ones it cannot publish", async () => {
    const query = queryReturning([
      { forProductVariantId: 70, ...uploaded },
      { forProductVariantId: 70, ...linked },
      { forProductVariantId: 71, ...uploaded, id: 44, fileHeader: Buffer.from("not an image") },
    ]);
    const reader = new PgCatalogVariantPublicationPhotoReader({ query } as unknown as Pool, publicUrl);
    const photos = await reader.listPublicationPhotos({ productVariantIds: [70, 71, 72], maxPhotosPerVariant: 20 });
    expect(photos.get(70)).toEqual({
      photos: [
        { assetId: 42, url: `https://catalog.example.com/api/catalog/images/42/${hash}.png`, position: 1, uploaded: true },
        { assetId: 7, url: "https://cdn.example.com/front.jpg", position: 0, uploaded: false },
      ],
      issues: [],
    });
    expect(photos.get(71)).toEqual({ photos: [], issues: [expect.objectContaining({ assetId: 44, code: "IMAGE_FORMAT_UNSUPPORTED" })] });
    expect(photos.get(72)).toEqual({ photos: [], issues: [] });
  });

  it("does not hide a failed catalog read", async () => {
    const failure = new Error("connection lost");
    const reader = new PgCatalogVariantPublicationPhotoReader({ query: vi.fn(async () => { throw failure; }) } as unknown as Pool, publicUrl);
    await expect(reader.listPublicationPhotos({ productVariantIds: [70], maxPhotosPerVariant: 20 })).rejects.toBe(failure);
  });
});
