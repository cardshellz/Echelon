import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgCatalogVariantMediaReader } from "../../catalog-media.reader";

describe("catalog-owned variant media reader", () => {
  it("batch-loads only product-level or current variant images with publishing order preserved", async () => {
    const query = vi.fn(async () => ({ rows: [
      { variant_id: 7, id: 3, product_variant_id: 7, url: "https://images.test/variant.jpg", alt_text: "Variant", storage_type: "url", has_file: false },
      { variant_id: 7, id: 2, product_variant_id: null, url: null, alt_text: "Product", storage_type: "file", has_file: true },
    ] }));
    const reader = new PgCatalogVariantMediaReader({ query } as unknown as Pool);
    const images = await reader.listImages([7, 8]);
    expect(images.get(7)?.map((image) => image.assetId)).toEqual([3, 2]);
    expect(images.get(7)?.[1]).toMatchObject({ url: null, hasFile: true, productVariantId: null });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("pv.product_id = pa.product_id");
    expect(sql).toContain("pa.product_variant_id IS NULL OR pa.product_variant_id = pv.id");
    expect(sql).toContain("pa.asset_type = 'image'");
    expect(sql).toContain("pa.is_primary DESC, pa.position ASC, pa.id ASC");
  });

  it("requires both asset and variant identities and rejects unsupported executable media", async () => {
    const query = vi.fn(async () => ({ rows: [{ file_data: Buffer.from("<svg/>"), mime_type: "image/svg+xml" }] }));
    const reader = new PgCatalogVariantMediaReader({ query } as unknown as Pool);
    await expect(reader.readImageFile({ productVariantId: 7, assetId: 99 })).resolves.toBeNull();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("pv.id = $1 AND pa.id = $2");
    expect(sql).toContain("pa.product_variant_id IS NULL OR pa.product_variant_id = pv.id");
    expect(sql).toContain("pa.storage_type IN ('file', 'both')");
    expect(sql).toContain("pa.mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')");
    expect(query.mock.calls[0]?.[1]).toEqual([7, 99, 10 * 1024 * 1024]);
  });

  it("returns not found for absent or mismatched assets", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const reader = new PgCatalogVariantMediaReader({ query } as unknown as Pool);
    await expect(reader.readImageFile({ productVariantId: 7, assetId: 99 })).resolves.toBeNull();
    await expect(reader.listImages([])).resolves.toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(1);
  });
});
