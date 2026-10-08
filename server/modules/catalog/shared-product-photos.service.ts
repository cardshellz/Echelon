import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { products, productAssets } from "@shared/schema";
import type { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { catalogPhotoIdSchema } from "@shared/catalog/product-asset-scope";
import { ProductAssetError } from "./product-asset-errors";
import { planSharedPhotoAdditions, type SharedImportedPhoto } from "./shared-product-photos.domain";
export type { SharedImportedPhoto } from "./shared-product-photos.domain";
const MAX_POSITION = 2147483647;
// Bound source payloads and writes, allowing repeated product photos across many SKUs.
const MAX_SOURCE_PHOTOS = 100000;
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
}).strict();
const requestSchema = z.object({
  productId: catalogPhotoIdSchema, photos: z.array(photoSchema).max(MAX_SOURCE_PHOTOS),
  actor: z.string().trim().min(1).max(200),
}).strict();
/** Catalog owns imported photos. Source variant links never imply a Catalog restriction. */
export function createSharedProductPhotoImporter(database: Pick<typeof db, "transaction">, clock: () => Date) {
  return {
    async append(input: {
      productId: number;
      photos: readonly SharedImportedPhoto[];
      actor: string;
    }): Promise<{
      created: number;
    }> {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success)
        throw new ProductAssetError("IMPORTED_PHOTOS_INVALID", "Imported photos have invalid product identity, URL or metadata.", 400);
      const { productId, photos, actor } = parsed.data;
      if (!photos.length)
        return { created: 0 };
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
        }))).returning({ id: productAssets.id });
        await persistAuditEvent(tx, {
          actor, action: "catalog.photos.imported_shared", target: `catalog.products:${productId}`,
          changes: {
            before: { assetIds: existing.map(photo => photo.id) },
            after: { addedAssetIds: created.map(photo => photo.id), productVariantId: null }
          },
          context: { productId, created: created.length },
        }, { timestamp: clock(), emitStructuredLog: false });
        return { created: created.length };
      });
    },
  };
}
