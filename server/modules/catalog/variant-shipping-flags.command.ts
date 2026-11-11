import { eq } from "drizzle-orm";
import { productVariants } from "@shared/schema";
import { db } from "../../db";

export type CatalogVariantShippingFlagsWriteExecutor = Pick<typeof db, "update">;

/**
 * Canonical Catalog command for confirming that a product variant ships in its
 * own container (`catalog.product_variants.ships_in_own_container = true`).
 *
 * Accepts an active Drizzle transaction or the root database handle so
 * cross-module workflows (such as Shipping Engine SIOC confirmation +
 * suggestion resolution) preserve single-transaction atomicity while keeping
 * `modules/catalog` as the writer of `catalog.product_variants`.
 */
export async function confirmProductVariantShipsInOwnContainer(
  productVariantId: number,
  executor: CatalogVariantShippingFlagsWriteExecutor = db,
): Promise<void> {
  await executor
    .update(productVariants)
    .set({ shipsInOwnContainer: true, updatedAt: new Date() })
    .where(eq(productVariants.id, productVariantId));
}
