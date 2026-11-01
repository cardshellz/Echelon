import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { products, productAssets } from "@shared/schema";
import type { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/transactional-audit";
import { catalogPhotoIdSchema } from "@shared/catalog/product-asset-scope";
import { ProductAssetError } from "./product-asset-errors";
import { planSharedPhotoAdditions, type SharedImportedPhoto } from "./shared-product-photos.domain";
import { fetchProductImage } from "./product-image-download.transport";
import { inspectCatalogImage } from "./catalog-image-inspection";
import { storeCatalogOriginal } from "./catalog-image-originals.service";
import { prepareOptionalCatalogRendition, type CatalogPublicationRendition, type CatalogRenditionWarning } from "./catalog-publication-rendition";
import type { DownloadableProductImage } from "./product-image-download.service";
export type { SharedImportedPhoto } from "./shared-product-photos.domain";
const MAX_POSITION = 2147483647;
// Bound source payloads and writes, allowing repeated product photos across many SKUs.
const MAX_SOURCE_PHOTOS = 100000;
// Downloads happen before a database transaction. Bound the aggregate retained
// bytes as well as the transport's 10 MB per-file limit.
const MAX_IMPORTED_ORIGINAL_BYTES = 100 * 1024 * 1024;
const photoSchema = z.object({
  url: z.string().url().max(4096).refine(value => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    }
    catch {
      return false;
    }
  }, "Photo URL must be HTTP(S) without credentials"),
  position: z.number().int().min(0).max(MAX_POSITION),
  altText: z.string().max(500).nullable().optional(),
  sourceAliases: z.array(z.string().url().max(4096)).max(10).optional(),
}).strict();
const requestSchema = z.object({
  productId: catalogPhotoIdSchema, photos: z.array(photoSchema).max(MAX_SOURCE_PHOTOS),
  actor: z.string().trim().min(1).max(200),
}).strict();
/** Catalog owns imported photos. Source variant links never imply a Catalog restriction. */
export function createSharedProductPhotoImporter(database: Pick<typeof db, "transaction" | "select">, clock: () => Date,
  readImage: (url: string) => Promise<DownloadableProductImage> = fetchProductImage) {
  return {
    async append(input: {
      productId: number;
      photos: readonly SharedImportedPhoto[];
      actor: string;
    }): Promise<{
      created: number;
      warnings?: Array<CatalogRenditionWarning & { url: string }>;
    }> {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success)
        throw new ProductAssetError("IMPORTED_PHOTOS_INVALID", "Imported photos have invalid product identity, URL or metadata.", 400);
      const { productId, photos, actor } = parsed.data;
      if (!photos.length)
        return { created: 0 };
      const snapshot = await database.select({ id: productAssets.id, url: productAssets.url, position: productAssets.position })
        .from(productAssets).where(eq(productAssets.productId, productId)).orderBy(asc(productAssets.id));
      const candidates = planSharedPhotoAdditions(snapshot, photos);
      const originals = new Map<string, DownloadableProductImage>();
      const renditions = new Map<string, CatalogPublicationRendition | null>();
      const warnings: Array<CatalogRenditionWarning & { url: string }> = [];
      let retainedBytes = 0;
      for (const candidate of candidates) {
        const image = await readImage(candidate.url);
        inspectCatalogImage(image);
        const {rendition,warning} = await prepareOptionalCatalogRendition(image);
        if (warning) {
          warnings.push({...warning,url:candidate.url});
          console.warn(JSON.stringify({event:"catalog.image_rendition.unavailable",productId,code:warning.code}));
        }
        retainedBytes += image.data.byteLength + (rendition?.image.data.byteLength ?? 0);
        if (retainedBytes > MAX_IMPORTED_ORIGINAL_BYTES)
          throw new ProductAssetError("IMPORTED_PHOTOS_TOO_LARGE", "The original images exceed the 100 MB per-product import limit. Import a smaller group of photos.", 413);
        originals.set(candidate.url, { data: Buffer.from(image.data), mimeType: image.mimeType });
        renditions.set(candidate.url, rendition);
      }
      return database.transaction(async (tx) => {
        const [product] = await tx.select({ id: products.id }).from(products)
          .where(eq(products.id, productId)).for("update");
        if (!product)
          throw new ProductAssetError("PRODUCT_NOT_FOUND", "Product not found.", 404);
        const existing = await tx.select({ id: productAssets.id, url: productAssets.url, position: productAssets.position })
          .from(productAssets).where(eq(productAssets.productId, productId)).orderBy(asc(productAssets.id)).for("update");
        const additions = planSharedPhotoAdditions(existing, photos);
        if (!additions.length)
          return { created: 0 };
        const created = await tx.insert(productAssets).values(additions.map(photo => ({
          ...photo, productId, assetType: "image",
        }))).returning({ id: productAssets.id, url: productAssets.url });
        const createdUrls = new Set(created.map(asset => asset.url));
        const appliedWarnings = warnings.filter(warning => createdUrls.has(warning.url));
        const now = clock();
        for (const asset of created) {
          const original = asset.url === null ? undefined : originals.get(asset.url);
          if (!original) throw new ProductAssetError("IMPORTED_PHOTOS_SOURCE_CHANGED", "Photo sources changed during import. Retry with the current gallery.", 409);
          await storeCatalogOriginal(tx, asset.id, original, "both", now, renditions.get(asset.url!) ?? null);
        }
        await persistAuditEvent(tx, {
          actor, action: "catalog.photos.imported_shared", target: `catalog.products:${productId}`,
          changes: {
            before: { assetIds: existing.map(photo => photo.id) },
            after: { addedAssetIds: created.map(photo => photo.id), productVariantId: null }
          },
          context: { productId, created: created.length, ...(appliedWarnings.length ? { renditionWarnings: appliedWarnings } : {}) },
        }, { timestamp: now, emitStructuredLog: false });
        return { created: created.length, ...(appliedWarnings.length ? { warnings: appliedWarnings } : {}) };
      });
    },
  };
}
