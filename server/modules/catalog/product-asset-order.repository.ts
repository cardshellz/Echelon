import { and, asc, eq } from "drizzle-orm";
import type { db } from "../../db";
import { productAssets, products } from "@shared/schema";
import { reorderProductAssetsSchema, type ReorderProductAssets } from "@shared/catalog/product-assets";
import { ProductAssetError } from "./product-asset-errors";

/** Positions are independent of the explicit primary image and variant ownership. */
export async function reorderCatalogAssets(database: Pick<typeof db, "transaction">, productId: number, input: ReorderProductAssets): Promise<void> {
  const parsed = reorderProductAssetsSchema.safeParse(input);
  if (!Number.isSafeInteger(productId) || productId <= 0 || !parsed.success) {
    throw new ProductAssetError("ASSET_ORDER_INVALID", "Provide a valid, complete image order.", 400);
  }
  const { orderedIds, expectedOrderedIds } = parsed.data;
  await database.transaction(async tx => {
    // Parent lock serializes reorders and blocks FK-backed uploads while we validate membership.
    const [product] = await tx.select({ id: products.id }).from(products)
      .where(eq(products.id, productId)).for("update");
    if (!product) throw new ProductAssetError("PRODUCT_NOT_FOUND", "Product not found.", 404);
    const assets = await tx.select({ id: productAssets.id }).from(productAssets)
      .where(eq(productAssets.productId, productId))
      .orderBy(asc(productAssets.position), asc(productAssets.id)).for("update");
    const currentIds = assets.map(asset => asset.id);
    const requested = new Set(orderedIds);
    if (orderedIds.length !== currentIds.length || currentIds.some(id => !requested.has(id))) {
      throw new ProductAssetError("ASSET_ORDER_CHANGED", "Images changed. Refresh the gallery and try again.", 409);
    }
    const alreadyApplied = currentIds.every((id, index) => orderedIds[index] === id);
    // A retry of an already committed request is a no-op, even with its old snapshot.
    if (alreadyApplied) return;
    if (expectedOrderedIds && (expectedOrderedIds.length !== currentIds.length
      || currentIds.some((id, index) => expectedOrderedIds[index] !== id))) {
      throw new ProductAssetError("ASSET_ORDER_CHANGED", "Image order changed in another session. Refresh and try again.", 409);
    }
    for (const [position, id] of orderedIds.entries()) {
      await tx.update(productAssets).set({ position })
        .where(and(eq(productAssets.productId, productId), eq(productAssets.id, id)));
    }
  });
}
