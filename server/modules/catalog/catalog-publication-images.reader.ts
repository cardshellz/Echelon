import type { Pool, PoolClient } from "pg";
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

/** A photo a listing publishes, with the catalog asset it came from. */
export interface CatalogPublicationPhoto {
  assetId: number;
  url: string;
  /** True when the URL is the public address of an uploaded file. */
  uploaded: boolean;
}

/** Keep catalog metadata usable while reporting photos that cannot be published. */
export function resolveCatalogPublicationPhotos(
  images: readonly CatalogPublicationImage[],
  publicUrl: CatalogPublicImageUrl,
): { photos: CatalogPublicationPhoto[]; issues: CatalogPublicationImageIssue[] } {
  const photos: CatalogPublicationPhoto[] = [];
  const issues: CatalogPublicationImageIssue[] = [];
  for (const image of images) {
    try {
      const url = resolveCatalogPublicationImage(image, publicUrl);
      if (url !== null) photos.push({ assetId: image.id, url, uploaded: image.url === null });
    } catch (error) {
      if (!(error instanceof ProductAssetError)) throw error;
      issues.push({ assetId: image.id, code: error.code, message: error.message });
    }
  }
  return { photos, issues };
}

/** The URLs alone, for callers that do not need the asset behind each one. */
export function resolveCatalogPublicationImages(
  images: readonly CatalogPublicationImage[],
  publicUrl: CatalogPublicImageUrl,
): { images: string[]; issues: CatalogPublicationImageIssue[] } {
  const { photos, issues } = resolveCatalogPublicationPhotos(images, publicUrl);
  return { images: photos.map((photo) => photo.url), issues };
}

/** The largest catalog asset or variant id (PostgreSQL integer). */
const MAX_CATALOG_ID = 2_147_483_647;

/**
 * The photos each size publishes, in listing order: the primary photo first,
 * then by position and id. A size has its product's photos and its own.
 *
 * Only the first `maxPhotosPerVariant` count. A photo is a non-blank URL or a
 * stored file; a blank URL is not a photo. Stored files are fingerprinted only
 * within that limit, once per photo, so a read never hashes a file the caller
 * will not publish. Each requested size has an entry, empty when it has no
 * photos.
 */
export async function readCatalogVariantPublicationImages(
  database: Pick<PoolClient, "query">,
  input: { productVariantIds: readonly number[]; maxPhotosPerVariant: number },
): Promise<Map<number, CatalogPublicationImage[]>> {
  if (input.productVariantIds.some((id) => !Number.isInteger(id) || id <= 0 || id > MAX_CATALOG_ID)
    || !Number.isSafeInteger(input.maxPhotosPerVariant) || input.maxPhotosPerVariant <= 0) {
    throw new ProductAssetError("CATALOG_IMAGE_READ_INVALID", "Catalog photos were requested with invalid sizes or an invalid photo limit.", 500);
  }
  const productVariantIds = [...new Set(input.productVariantIds)];
  const byVariantId = new Map<number, CatalogPublicationImage[]>(productVariantIds.map((id) => [id, []]));
  if (productVariantIds.length === 0) return byVariantId;
  const result = await database.query<CatalogPublicationImage & { forProductVariantId: number }>(`
    WITH ranked AS (
      SELECT pv.id AS variant_id, pa.id AS asset_id,
        ROW_NUMBER() OVER (
          PARTITION BY pv.id ORDER BY pa.is_primary DESC, pa.position ASC, pa.id ASC
        ) AS photo_rank
      FROM catalog.product_variants pv
      INNER JOIN catalog.product_assets pa ON pa.product_id = pv.product_id
      WHERE pv.id = ANY($1::int[]) AND pa.asset_type = 'image'
        AND (pa.product_variant_id IS NULL OR pa.product_variant_id = pv.id)
        AND (NULLIF(BTRIM(pa.url), '') IS NOT NULL OR pa.storage_type IN ('file', 'both'))
    ), kept AS (
      SELECT variant_id, asset_id, photo_rank FROM ranked WHERE photo_rank <= $2
    ), photos AS MATERIALIZED (
      -- One row per photo: a product photo that several sizes share is hashed once.
      SELECT pa.id, pa.product_id, pa.product_variant_id, pa.position, pa.storage_type, pa.mime_type,
        CASE WHEN NULLIF(BTRIM(pa.url), '') IS NOT NULL THEN pa.url END AS url,
        CASE WHEN NULLIF(BTRIM(pa.url), '') IS NULL AND pa.storage_type IN ('file', 'both')
          THEN octet_length(pa.file_data) END AS file_bytes,
        CASE WHEN NULLIF(BTRIM(pa.url), '') IS NULL AND pa.storage_type IN ('file', 'both')
          AND octet_length(pa.file_data) BETWEEN 1 AND $3
          THEN encode(sha256(pa.file_data), 'hex') END AS file_hash,
        CASE WHEN NULLIF(BTRIM(pa.url), '') IS NULL AND pa.storage_type IN ('file', 'both')
          AND octet_length(pa.file_data) BETWEEN 1 AND $3
          THEN substring(pa.file_data FROM 1 FOR 12) END AS file_header
      FROM catalog.product_assets pa
      WHERE pa.id IN (SELECT asset_id FROM kept)
    )
    SELECT kept.variant_id AS "forProductVariantId", photos.id, photos.product_id AS "productId",
      photos.product_variant_id AS "productVariantId", photos.position, photos.url,
      photos.storage_type AS "storageType", photos.mime_type AS "mimeType",
      photos.file_bytes AS "fileBytes", photos.file_hash AS "fileHash", photos.file_header AS "fileHeader"
    FROM kept
    INNER JOIN photos ON photos.id = kept.asset_id
    ORDER BY kept.variant_id, kept.photo_rank
  `, [productVariantIds, input.maxPhotosPerVariant, MAX_PRODUCT_IMAGE_BYTES]);
  for (const { forProductVariantId, ...image } of result.rows) {
    byVariantId.get(forProductVariantId)?.push(image);
  }
  return byVariantId;
}

export interface CatalogVariantPublicationPhotos {
  /** In listing order. */
  photos: CatalogPublicationPhoto[];
  /** Photos within the limit that cannot be published, such as an uploaded file without a public address. */
  issues: CatalogPublicationImageIssue[];
}

export interface CatalogVariantPublicationPhotoReader {
  listPublicationPhotos(input: {
    productVariantIds: readonly number[];
    maxPhotosPerVariant: number;
  }): Promise<Map<number, CatalogVariantPublicationPhotos>>;
}

/** Catalog owns photos; marketplace URLs come from configuration, never a request's Host header. */
export class PgCatalogVariantPublicationPhotoReader implements CatalogVariantPublicationPhotoReader {
  constructor(
    private readonly database: Pick<Pool, "query">,
    private readonly publicUrl: CatalogPublicImageUrl,
  ) {}

  async listPublicationPhotos(input: {
    productVariantIds: readonly number[];
    maxPhotosPerVariant: number;
  }): Promise<Map<number, CatalogVariantPublicationPhotos>> {
    const images = await readCatalogVariantPublicationImages(this.database, input);
    return new Map([...images].map(([productVariantId, variantImages]) =>
      [productVariantId, resolveCatalogPublicationPhotos(variantImages, this.publicUrl)]));
  }
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
