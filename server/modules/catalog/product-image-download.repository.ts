import { sql } from "drizzle-orm";
import type { db } from "../../db";
import { MAX_PRODUCT_IMAGE_BYTES, type ProductImageDownloadSource } from "./product-image-download.service";

export async function readProductImageDownload(database: Pick<typeof db, "execute">, assetId: number): Promise<ProductImageDownloadSource | null> {
  const result = await database.execute<{
    sku: string | null; url: string | null; data: Buffer | null; mime_type: string | null; file_bytes: number | null;
  }>(sql`
    SELECT p.sku, pa.url, pa.mime_type,
      CASE WHEN pa.storage_type IN ('file', 'both') THEN octet_length(pa.file_data) END AS file_bytes,
      CASE WHEN pa.storage_type IN ('file', 'both') AND octet_length(pa.file_data) <= ${MAX_PRODUCT_IMAGE_BYTES}
        THEN pa.file_data END AS data
    FROM catalog.product_assets pa
    JOIN catalog.products p ON p.id = pa.product_id
    WHERE pa.id = ${assetId} AND pa.asset_type = 'image'
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { sku: row.sku, url: row.url, data: row.data, mimeType: row.mime_type, fileBytes: row.file_bytes } : null;
}
