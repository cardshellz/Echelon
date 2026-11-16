import { eq } from "drizzle-orm";
import { productVariants, products } from "@shared/schema";
import { db, pool } from "../../db";

export async function updateCatalogProductType(
  productId: number,
  productType: string | null,
  database: any = db,
): Promise<void> {
  await database
    .update(products)
    .set({ productType, updatedAt: new Date() })
    .where(eq(products.id, productId));
}

export async function bulkUpdateCatalogProductType(
  productIds: readonly number[],
  productType: string | null,
  queryPool: Pick<typeof pool, "connect"> = pool,
): Promise<void> {
  const client = await queryPool.connect();
  try {
    await client.query(
      `UPDATE catalog.products SET product_type = $1, updated_at = NOW() WHERE id = ANY($2::int[])`,
      [productType, [...productIds]],
    );
  } finally {
    client.release();
  }
}

export async function updateCatalogProductEbayBrowseCategory(
  productId: number,
  ebayBrowseCategoryId: string | null,
  ebayBrowseCategoryName: string | null,
  queryPool: Pick<typeof pool, "connect"> = pool,
): Promise<void> {
  const client = await queryPool.connect();
  try {
    await client.query(
      "UPDATE catalog.products SET ebay_browse_category_id = $1, ebay_browse_category_name = $2 WHERE id = $3",
      [ebayBrowseCategoryId, ebayBrowseCategoryName, productId],
    );
  } finally {
    client.release();
  }
}

export async function setCatalogVariantEbayListingExcludedInTx(
  tx: any,
  variantId: number,
  excluded: boolean,
): Promise<void> {
  await tx
    .update(productVariants)
    .set({ ebayListingExcluded: excluded })
    .where(eq(productVariants.id, variantId));
}
