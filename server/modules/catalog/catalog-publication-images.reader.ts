import type { PoolClient } from "pg";
import { ProductAssetError } from "./product-asset-errors";
import { CATALOG_IMAGE_HASH_PATTERN, type CatalogPublicImageUrl } from "./catalog-public-image";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  validateProductImage,
  type DownloadableProductImage,
} from "./product-image-download.service";

export interface CatalogPublicationImage {
  id: number;
  productId: number;
  productVariantId: number | null;
  position: number;
  url: string | null;
  storageType: string;
  mimeType: string | null;
  fileBytes: number | null;
  fileHash: string | null;
  fileHeader: Buffer | null;
}

/** Metadata only: listing pages do not transfer image blobs from PostgreSQL. */
export async function readCatalogPublicationImages(
  database: Pick<PoolClient, "query">,
  productIds: readonly number[],
): Promise<CatalogPublicationImage[]> {
  if (productIds.length === 0) return [];
  const result = await database.query<CatalogPublicationImage>(`
    SELECT id, product_id AS "productId", product_variant_id AS "productVariantId", position,
      url, storage_type AS "storageType", mime_type AS "mimeType",
      CASE WHEN storage_type IN ('file', 'both') AND url IS NULL
        THEN octet_length(file_data) END AS "fileBytes",
      CASE WHEN storage_type IN ('file', 'both') AND url IS NULL
        AND octet_length(file_data) BETWEEN 1 AND $2
        THEN encode(sha256(file_data), 'hex') END AS "fileHash",
      CASE WHEN storage_type IN ('file', 'both') AND url IS NULL
        AND octet_length(file_data) BETWEEN 1 AND $2
        THEN substring(file_data FROM 1 FOR 12) END AS "fileHeader"
    FROM catalog.product_assets
    WHERE product_id = ANY($1::int[]) AND asset_type = 'image'
    ORDER BY product_id, position, id
  `, [productIds, MAX_PRODUCT_IMAGE_BYTES]);
  return result.rows;
}

export function resolveCatalogPublicationImage(
  image: CatalogPublicationImage,
  publicUrl: CatalogPublicImageUrl,
): string | null {
  if (image.url !== null) return image.url;
  if (image.storageType !== "file" && image.storageType !== "both") return null;
  if (!image.fileBytes || image.fileBytes > MAX_PRODUCT_IMAGE_BYTES || !image.fileHash || !image.fileHeader) {
    throw new ProductAssetError("CATALOG_IMAGE_UNAVAILABLE", `Replace uploaded catalog image ${image.id}: its file is missing, empty or larger than 10 MB.`, 422);
  }
  // Check the same signature as the public read boundary without loading the full blob.
  const validated = validateProductImage({ data: image.fileHeader, mimeType: image.mimeType ?? "" });
  return publicUrl(image.id, image.fileHash, validated.mimeType);
}

export interface CatalogPublicationImageIssue {
  assetId: number;
  code: string;
  message: string;
}

/** Keep catalog metadata usable while reporting photos that cannot be published. */
export function resolveCatalogPublicationImages(
  images: readonly CatalogPublicationImage[],
  publicUrl: CatalogPublicImageUrl,
): { images: string[]; issues: CatalogPublicationImageIssue[] } {
  const urls: string[] = [];
  const issues: CatalogPublicationImageIssue[] = [];
  for (const image of images) {
    try {
      const url = resolveCatalogPublicationImage(image, publicUrl);
      if (url !== null) urls.push(url);
    } catch (error) {
      if (!(error instanceof ProductAssetError)) throw error;
      issues.push({ assetId: image.id, code: error.code, message: error.message });
    }
  }
  return { images: urls, issues };
}

/** The full content fingerprint is required; numeric asset IDs alone disclose nothing. */
export async function readPublicCatalogImage(
  database: Pick<PoolClient, "query">,
  assetId: number,
  contentHash: string,
): Promise<DownloadableProductImage | null> {
  if (!Number.isSafeInteger(assetId) || assetId <= 0 || assetId > 2_147_483_647
    || !CATALOG_IMAGE_HASH_PATTERN.test(contentHash)) return null;
  const result = await database.query<{ data: Buffer; mimeType: string }>(`
    SELECT file_data AS data, mime_type AS "mimeType"
    FROM catalog.product_assets
    WHERE id = $1 AND asset_type = 'image' AND storage_type IN ('file', 'both')
      AND mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      AND CASE WHEN octet_length(file_data) BETWEEN 1 AND $3
        THEN encode(sha256(file_data), 'hex') = $2 ELSE false END
    LIMIT 1
  `, [assetId, contentHash, MAX_PRODUCT_IMAGE_BYTES]);
  const image = result.rows[0];
  if (!image) return null;
  try {
    return validateProductImage(image);
  } catch (error) {
    if (error instanceof ProductAssetError) return null;
    throw error;
  }
}
