import { and, eq, inArray, sql } from "drizzle-orm";
import { channelListings, channelProductIdentities, products, productVariants } from "@shared/schema";
import type { db } from "../../../db";
import type { CatalogIdentityCandidate, ChannelIdentityCandidate } from "../domain/order-line-catalog-identity";
import { OrderLineIdentityError } from "../domain/order-line-catalog-identity";

export type CatalogIdentityDatabase = Pick<typeof db, "select">;
const variantSelection = {
  id: productVariants.id, sku: productVariants.sku, isActive: productVariants.isActive,
  compareAtPriceCents: productVariants.compareAtPriceCents,
  productId: productVariants.productId, trackInventory: productVariants.trackInventory,
};
export function createOrderLineCatalogIdentityRepository(database: CatalogIdentityDatabase) {
  async function lockParents(candidates: readonly { productId?: number }[]): Promise<Set<number>> {
    const ids = [...new Set(candidates.flatMap(candidate => candidate.productId === undefined ? [] : [candidate.productId]))].sort((a, b) => a - b);
    if (ids.length) await database.select({ id: products.id }).from(products).where(inArray(products.id, ids)).orderBy(products.id).for("share");
    return new Set(ids);
  }
  function verifyLockedParents(candidates: readonly { productId?: number }[], locked: ReadonlySet<number>): void {
    if (candidates.some(candidate => candidate.productId === undefined || !locked.has(candidate.productId))) {
      throw new OrderLineIdentityError("ORDER_LINE_CATALOG_CHANGED", "Catalog mapping changed while resolving its inventory policy; retry resolution", {});
    }
  }
  return {
    async byChannelVariant(channelId: number, externalVariantId: string): Promise<ChannelIdentityCandidate[]> {
      const query = () => database.select({ ...variantSelection, externalProductId: channelListings.externalProductId })
        .from(channelListings)
        .innerJoin(productVariants, eq(productVariants.id, channelListings.productVariantId))
        .where(and(eq(channelListings.channelId, channelId), eq(channelListings.externalVariantId, externalVariantId)))
        .limit(2);
      // Same lock order as catalog policy writes: parent first, then variant/mapping.
      const lockedParents = await lockParents(await query());
      const candidates = await query().for("share");
      verifyLockedParents(candidates, lockedParents);
      return candidates;
    },
    async byChannelProduct(channelId: number, externalProductId: string) {
      return database.select({ productId: products.id, sku: products.sku, isActive: products.isActive,
        inventoryTracking: products.inventoryTrackingDefault,
        hasVariants: sql<boolean>`EXISTS (SELECT 1 FROM catalog.product_variants variant
          WHERE variant.product_id = catalog.products.id)`,
      }).from(channelProductIdentities).innerJoin(products, eq(products.id, channelProductIdentities.productId))
        .where(and(eq(channelProductIdentities.channelId, channelId), eq(channelProductIdentities.externalProductId, externalProductId)))
        .limit(2).for("share");
    },
    async bySku(sku: string, channelId: number): Promise<CatalogIdentityCandidate[]> {
      const query = () => database.select({ ...variantSelection,
        channelProductIds: sql<string[]>`ARRAY(SELECT external_product_id FROM channels.channel_listings
          WHERE product_variant_id = catalog.product_variants.id AND channel_id = ${channelId} AND external_product_id IS NOT NULL)`,
        channelVariantIds: sql<string[]>`ARRAY(SELECT external_variant_id FROM channels.channel_listings
          WHERE product_variant_id = catalog.product_variants.id AND channel_id = ${channelId} AND external_variant_id IS NOT NULL)`,
      }).from(productVariants)
        .where(and(eq(productVariants.sku, sku), eq(productVariants.isActive, true))).limit(2);
      const lockedParents = await lockParents(await query());
      const candidates = await query().for("share");
      verifyLockedParents(candidates, lockedParents);
      return candidates;
    },
    async catalogProductSku(productId: number): Promise<string | null> {
      const [product] = await database.select({ sku: products.sku }).from(products).where(eq(products.id, productId)).limit(1);
      if (!product) throw new OrderLineIdentityError("WMS_CATALOG_PRODUCT_MISSING", "Resolved catalog product no longer exists", {});
      return product.sku;
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
