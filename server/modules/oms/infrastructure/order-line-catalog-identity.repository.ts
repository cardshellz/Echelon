import { and, eq } from "drizzle-orm";
import { channelListings, productVariants } from "@shared/schema";
import type { db } from "../../../db";
import type { CatalogIdentityCandidate, ChannelIdentityCandidate } from "../domain/order-line-catalog-identity";
import { OrderLineIdentityError } from "../domain/order-line-catalog-identity";

export type CatalogIdentityDatabase = Pick<typeof db, "select">;
const variantSelection = {
  id: productVariants.id, sku: productVariants.sku, isActive: productVariants.isActive,
  compareAtPriceCents: productVariants.compareAtPriceCents,
};
export function createOrderLineCatalogIdentityRepository(database: CatalogIdentityDatabase) {
  return {
    async byChannelVariant(channelId: number, externalVariantId: string): Promise<ChannelIdentityCandidate[]> {
      return database.select({ ...variantSelection, externalProductId: channelListings.externalProductId })
        .from(channelListings)
        .innerJoin(productVariants, eq(productVariants.id, channelListings.productVariantId))
        .where(and(eq(channelListings.channelId, channelId), eq(channelListings.externalVariantId, externalVariantId)))
        // Preserve the exact mapping and catalog snapshot until the caller commits the OMS line.
        .limit(2).for("share");
    },
    async bySku(sku: string): Promise<CatalogIdentityCandidate[]> {
      return database.select(variantSelection).from(productVariants)
        .where(and(eq(productVariants.sku, sku), eq(productVariants.isActive, true))).limit(2).for("share");
    },
    async catalogSku(variantId: number): Promise<string | null> {
      const [variant] = await database.select({ sku: productVariants.sku }).from(productVariants)
        .where(eq(productVariants.id, variantId)).limit(1);
      if (!variant) {
        throw new OrderLineIdentityError("WMS_CATALOG_VARIANT_MISSING", "Resolved order variant no longer exists", { variantId });
      }
      return variant.sku;
    },
  };
}
