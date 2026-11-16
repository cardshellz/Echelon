import { and, eq, inArray } from "drizzle-orm";
import {
  channelFeeds,
  channelListings,
  productAssets,
  productCategories,
  productVariants,
  products,
  shippingGroups,
} from "@shared/schema";
import { db } from "../../../db";
import {
  deactivateAllChannelFeedsByVariantIdInChannels,
  upsertShopifyVariantFeedAndListingLinkInTx,
} from "../../channels/channel-feed-listing-mutations.api";

type CatalogTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assignProductsShippingGroupInTx(
  tx: CatalogTx,
  productIds: readonly number[],
  shippingGroupId: number | null,
  changedAt: Date,
) {
  return tx
    .update(products)
    .set({ shippingGroupId, updatedAt: changedAt })
    .where(inArray(products.id, [...productIds]))
    .returning({ id: products.id });
}

export async function insertShippingGroupRecord(
  values: typeof shippingGroups.$inferInsert,
  database: Pick<typeof db, "insert"> = db,
) {
  const [group] = await database.insert(shippingGroups).values(values).returning();
  return group;
}

export async function updateShippingGroupRecordById(
  id: number,
  values: Partial<typeof shippingGroups.$inferInsert>,
  database: Pick<typeof db, "update"> = db,
) {
  const [group] = await database
    .update(shippingGroups)
    .set(values)
    .where(eq(shippingGroups.id, id))
    .returning();
  return group;
}

export async function insertProductCategoryRecord(
  values: typeof productCategories.$inferInsert,
  database: Pick<typeof db, "insert"> = db,
) {
  const [category] = await database.insert(productCategories).values(values).returning();
  return category;
}

export async function clearPrimaryProductAssetsForProduct(
  productId: number,
  database: Pick<typeof db, "update"> = db,
): Promise<void> {
  await database
    .update(productAssets)
    .set({ isPrimary: 0 })
    .where(eq(productAssets.productId, productId));
}

export async function deactivateVariantChannelFeedsInTx(
  tx: CatalogTx,
  productVariantId: number,
): Promise<void> {
  await deactivateAllChannelFeedsByVariantIdInChannels(tx, productVariantId);
}

export async function updateScopedVariantPackageAttributesInTx(
  tx: CatalogTx,
  productId: number,
  variantId: number,
  serializedUpdates: Partial<typeof productVariants.$inferInsert>,
) {
  const [variant] = await tx
    .update(productVariants)
    .set({ ...serializedUpdates, updatedAt: new Date() })
    .where(and(eq(productVariants.productId, productId), eq(productVariants.id, variantId)))
    .returning();
  return variant ?? null;
}

export async function updateVariantPackageAttributesByIdInTx(
  tx: CatalogTx,
  variantId: number,
  serializedUpdates: Partial<typeof productVariants.$inferInsert>,
) {
  const [variant] = await tx
    .update(productVariants)
    .set({ ...serializedUpdates, updatedAt: new Date() })
    .where(eq(productVariants.id, variantId))
    .returning();
  return variant ?? null;
}

export async function linkVariantShopifyFeedAndListingInTx(
  tx: CatalogTx,
  input: {
    variantId: number;
    channelId: number;
    shopifyProductId: string;
    shopifyVariantId: string;
    shopifyInventoryItemId: string | null;
    effectiveSku: string | null;
    variantUpdates: Partial<typeof productVariants.$inferInsert>;
  },
) {
  const [updatedVariant] = await tx
    .update(productVariants)
    .set(input.variantUpdates)
    .where(eq(productVariants.id, input.variantId))
    .returning();

  const { feedIds, listingIds } = await upsertShopifyVariantFeedAndListingLinkInTx(tx, {
    channelId: input.channelId,
    variantId: input.variantId,
    shopifyProductId: input.shopifyProductId,
    shopifyVariantId: input.shopifyVariantId,
    shopifyInventoryItemId: input.shopifyInventoryItemId,
    effectiveSku: input.effectiveSku,
  });

  return { updatedVariant, feedIds, listingIds };
}
