import type { Pool } from "pg";

/** Matches the catalog upload limit; preview reads must not return oversized legacy blobs. */
const MAX_CATALOG_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;

export interface CatalogVariantImage {
  assetId: number;
  productVariantId: number | null;
  url: string | null;
  altText: string | null;
  storageType: string;
  hasFile: boolean;
}

export interface CatalogImageFile { data: Buffer; mimeType: string }

export interface CatalogVariantMediaReader {
  listImages(productVariantIds: readonly number[]): Promise<Map<number, CatalogVariantImage[]>>;
  readImageFile(input: { productVariantId: number; assetId: number }): Promise<CatalogImageFile | null>;
}

/** Catalog owns blobs. Callers must authorize the viewer before reading a file. */
export class PgCatalogVariantMediaReader implements CatalogVariantMediaReader {
  constructor(private readonly dbPool: Pool) {}

  async listImages(productVariantIds: readonly number[]): Promise<Map<number, CatalogVariantImage[]>> {
    if (productVariantIds.length === 0) return new Map();
    const result = await this.dbPool.query<{
      variant_id: number; id: number; product_variant_id: number | null; url: string | null;
      alt_text: string | null; storage_type: string; has_file: boolean;
    }>(
      `SELECT pv.id AS variant_id, pa.id, pa.product_variant_id, pa.url, pa.alt_text, pa.storage_type,
              pa.file_data IS NOT NULL
                AND octet_length(pa.file_data) <= $2
                AND pa.mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif') AS has_file
       FROM catalog.product_assets pa
       INNER JOIN catalog.product_variants pv ON pv.product_id = pa.product_id
       WHERE pv.id = ANY($1::int[]) AND pa.asset_type = 'image'
         AND (pa.product_variant_id IS NULL OR pa.product_variant_id = pv.id)
       ORDER BY pv.id, pa.is_primary DESC, pa.position ASC, pa.id ASC`,
      [productVariantIds, MAX_CATALOG_PREVIEW_IMAGE_BYTES],
    );
    const images = new Map<number, CatalogVariantImage[]>();
    for (const row of result.rows) {
      const entries = images.get(row.variant_id) ?? [];
      entries.push({
        assetId: row.id, productVariantId: row.product_variant_id, url: row.url,
        altText: row.alt_text, storageType: row.storage_type, hasFile: row.has_file,
      });
      images.set(row.variant_id, entries);
    }
    return images;
  }

  async readImageFile(input: { productVariantId: number; assetId: number }): Promise<CatalogImageFile | null> {
    const result = await this.dbPool.query<{ file_data: Buffer; mime_type: string }>(
      `SELECT pa.file_data, pa.mime_type
       FROM catalog.product_assets pa
       INNER JOIN catalog.product_variants pv ON pv.product_id = pa.product_id
       WHERE pv.id = $1 AND pa.id = $2 AND pa.asset_type = 'image'
         AND (pa.product_variant_id IS NULL OR pa.product_variant_id = pv.id)
         AND pa.storage_type IN ('file', 'both') AND pa.file_data IS NOT NULL
         AND octet_length(pa.file_data) <= $3
         AND pa.mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
       LIMIT 1`,
      [input.productVariantId, input.assetId, MAX_CATALOG_PREVIEW_IMAGE_BYTES],
    );
    const row = result.rows[0];
    if (!row || !Buffer.isBuffer(row.file_data)
      || row.file_data.byteLength > MAX_CATALOG_PREVIEW_IMAGE_BYTES
      || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(row.mime_type)) return null;
    return { data: row.file_data, mimeType: row.mime_type };
  }
}
