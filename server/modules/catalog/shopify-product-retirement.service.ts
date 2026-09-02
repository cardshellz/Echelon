/**
 * Retire the local mapping when a Shopify product is deleted upstream.
 *
 * The products/delete webhook used to read SKUs out of `payload.variants` and
 * delete pick locations with them — but Shopify's delete payload carries only
 * the product id, so it extracted nothing and did nothing. The mapping in
 * `catalog.products.shopify_product_id` therefore outlived the listing forever,
 * which is how we accumulated 23 catalog rows pointing at deleted products and
 * a stream of `Owner does not exist.` dead letters from later metafield writes.
 *
 * Retiring means dropping the pointer, not the product: the Echelon product and
 * its history stay, it simply stops claiming a listing that no longer exists.
 * A relisted item is re-mapped by the next import.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { productLocations, products, productVariants } from "@shared/schema";
import { db } from "../../db";

export interface RetireDeletedShopifyProductResult {
  shopifyProductId: string;
  mappingsRetired: number;
  pickLocationsRemoved: number;
  retiredProductIds: number[];
}

export async function retireDeletedShopifyProduct(
  shopifyProductId: string | number,
): Promise<RetireDeletedShopifyProductResult> {
  const shopifyId = String(shopifyProductId).trim();
  const empty: RetireDeletedShopifyProductResult = {
    shopifyProductId: shopifyId,
    mappingsRetired: 0,
    pickLocationsRemoved: 0,
    retiredProductIds: [],
  };
  if (!/^\d+$/.test(shopifyId)) return empty;

  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.shopifyProductId, shopifyId));
    if (owned.length === 0) return empty;

    const productIds = owned.map((row) => row.id);

    // SKUs come from OUR variants, not from the webhook payload — that is the
    // whole reason the old handler was a no-op.
    const skuRows = await tx
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(and(inArray(productVariants.productId, productIds), isNotNull(productVariants.sku)));
    const skus = skuRows
      .map((row) => row.sku)
      .filter((sku): sku is string => !!sku && sku.trim() !== "")
      .map((sku) => sku.toUpperCase());

    let pickLocationsRemoved = 0;
    if (skus.length > 0) {
      const removed = await tx
        .delete(productLocations)
        .where(inArray(productLocations.sku, skus))
        .returning({ id: productLocations.id });
      pickLocationsRemoved = removed.length;
    }

    const retired = await tx
      .update(products)
      .set({ shopifyProductId: null, updatedAt: new Date() })
      .where(eq(products.shopifyProductId, shopifyId))
      .returning({ id: products.id });

    return {
      shopifyProductId: shopifyId,
      mappingsRetired: retired.length,
      pickLocationsRemoved,
      retiredProductIds: retired.map((row) => row.id),
    };
  });
}
