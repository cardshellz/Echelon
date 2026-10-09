import { and, eq } from "drizzle-orm";
import { productAssets, products, productVariants } from "@shared/schema";
import type { ProductAssetScopeCommand, ProductAssetScopeResult } from "@shared/catalog/product-asset-scope";
import type { db } from "../../db";
import { ProductAssetError } from "./product-asset-errors";
import { planProductAssetScopeChange } from "./product-asset-scope.domain";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Called only inside the command transaction; never commits independently. */
export async function changeProductAssetScope(
  tx: Transaction, productId: number, assetId: number, command: ProductAssetScopeCommand,
): Promise<ProductAssetScopeResult> {
  // Same parent-first lock order as gallery reordering. The asset lock also
  // serializes deletes/edits; the variant lock protects its product membership.
  const [product] = await tx.select({ id: products.id }).from(products)
    .where(eq(products.id, productId)).for("update");
  if (!product) throw new ProductAssetError("PRODUCT_NOT_FOUND", "Product not found.", 404);
  const [asset] = await tx.select({ id: productAssets.id, productVariantId: productAssets.productVariantId })
    .from(productAssets).where(and(eq(productAssets.productId, productId), eq(productAssets.id, assetId))).for("update");
  if (!asset) throw new ProductAssetError("ASSET_NOT_FOUND", "This photo no longer belongs to this product. Refresh the gallery.", 404);
  if (command.productVariantId !== null) {
    const [variant] = await tx.select({ id: productVariants.id }).from(productVariants)
      .where(and(eq(productVariants.id, command.productVariantId), eq(productVariants.productId, productId))).for("share");
    if (!variant) throw new ProductAssetError("ASSET_VARIANT_INVALID", "Choose a variant belonging to this product.", 400);
  }
  const changed = planProductAssetScopeChange(asset.productVariantId, command);
  if (changed) await tx.update(productAssets).set({ productVariantId: command.productVariantId })
    .where(and(eq(productAssets.productId, productId), eq(productAssets.id, assetId)));
  return { productId, assetId, productVariantId: command.productVariantId, changed };
}
