import {
  db,
  channelProductOverrides,
  channelVariantOverrides,
  channelPricing,
  channelListings,
  channelAssetOverrides,
  channelProductLines,
  productLines,
  channels,
  eq,
  and,
  sql,
} from "../../storage/base";
import type {
  ChannelProductOverride,
  InsertChannelProductOverride,
  ChannelVariantOverride,
  InsertChannelVariantOverride,
  ChannelPricing,
  InsertChannelPricing,
  ChannelListing,
  InsertChannelListing,
  ChannelAssetOverride,
  InsertChannelAssetOverride,
} from "../../storage/base";

export interface IChannelCatalogStorage {
  getChannelProductOverride(channelId: number, productId: number): Promise<ChannelProductOverride | undefined>;
  getChannelProductOverridesByProduct(productId: number): Promise<ChannelProductOverride[]>;
  upsertChannelProductOverride(data: InsertChannelProductOverride): Promise<ChannelProductOverride>;
  deleteChannelProductOverride(channelId: number, productId: number): Promise<boolean>;

  getChannelVariantOverride(channelId: number, productVariantId: number): Promise<ChannelVariantOverride | undefined>;
  getChannelVariantOverridesByProduct(channelId: number, productId: number): Promise<ChannelVariantOverride[]>;
  upsertChannelVariantOverride(data: InsertChannelVariantOverride): Promise<ChannelVariantOverride>;
  deleteChannelVariantOverride(channelId: number, productVariantId: number): Promise<boolean>;

  getChannelPricing(channelId: number, productVariantId: number): Promise<ChannelPricing | undefined>;
  getChannelPricingByProduct(channelId: number, productId: number): Promise<ChannelPricing[]>;
  upsertChannelPricing(data: InsertChannelPricing): Promise<ChannelPricing>;
  deleteChannelPricing(channelId: number, productVariantId: number): Promise<boolean>;

  getChannelListing(channelId: number, productVariantId: number): Promise<ChannelListing | undefined>;
  getChannelListingsByProduct(channelId: number, productId: number): Promise<ChannelListing[]>;
  upsertChannelListing(data: InsertChannelListing): Promise<ChannelListing>;
  getChannelListingByExternalId(channelId: number, externalProductId: string): Promise<ChannelListing | undefined>;
  getChannelListingsByChannel(channelId: number): Promise<ChannelListing[]>;

  getChannelAssetOverridesByProduct(channelId: number, productId: number): Promise<ChannelAssetOverride[]>;
  upsertChannelAssetOverride(data: InsertChannelAssetOverride): Promise<ChannelAssetOverride>;
  deleteChannelAssetOverride(channelId: number, productAssetId: number): Promise<boolean>;

  // Channel product lines (which product lines feed into which channels)
  replaceChannelProductLines(channelId: number, productLineIds: number[]): Promise<void>;
  getChannelProductLinesForChannel(channelId: number): Promise<{ id: number; code: string; name: string; isActive: boolean | null }[]>;
}

export const channelCatalogMethods: IChannelCatalogStorage = {
  async getChannelProductOverride(channelId: number, productId: number): Promise<ChannelProductOverride | undefined> {
    const result = await db.select().from(channelProductOverrides)
      .where(and(
        eq(channelProductOverrides.channelId, channelId),
        eq(channelProductOverrides.productId, productId)
      ));
    return result[0];
  },

  async getChannelProductOverridesByProduct(productId: number): Promise<ChannelProductOverride[]> {
    return await db.select().from(channelProductOverrides)
      .where(eq(channelProductOverrides.productId, productId));
  },

  async upsertChannelProductOverride(data: InsertChannelProductOverride): Promise<ChannelProductOverride> {
    const result = await db.insert(channelProductOverrides)
      .values(data)
      .onConflictDoUpdate({
        target: [channelProductOverrides.channelId, channelProductOverrides.productId],
        set: {
          titleOverride: data.titleOverride,
          descriptionOverride: data.descriptionOverride,
          bulletPointsOverride: data.bulletPointsOverride,
          categoryOverride: data.categoryOverride,
          tagsOverride: data.tagsOverride,
          itemSpecifics: data.itemSpecifics,
          marketplaceCategoryId: data.marketplaceCategoryId,
          listingFormat: data.listingFormat,
          conditionId: data.conditionId,
          isListed: data.isListed,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async deleteChannelProductOverride(channelId: number, productId: number): Promise<boolean> {
    const result = await db.delete(channelProductOverrides)
      .where(and(
        eq(channelProductOverrides.channelId, channelId),
        eq(channelProductOverrides.productId, productId)
      ))
      .returning();
    return result.length > 0;
  },

  async getChannelVariantOverride(channelId: number, productVariantId: number): Promise<ChannelVariantOverride | undefined> {
    const result = await db.select().from(channelVariantOverrides)
      .where(and(
        eq(channelVariantOverrides.channelId, channelId),
        eq(channelVariantOverrides.productVariantId, productVariantId)
      ));
    return result[0];
  },

  async getChannelVariantOverridesByProduct(channelId: number, productId: number): Promise<ChannelVariantOverride[]> {
    return await db.select().from(channelVariantOverrides)
      .where(and(
        eq(channelVariantOverrides.channelId, channelId),
        sql`${channelVariantOverrides.productVariantId} IN (
          SELECT id FROM product_variants WHERE product_id = ${productId}
        )`
      ));
  },

  async upsertChannelVariantOverride(data: InsertChannelVariantOverride): Promise<ChannelVariantOverride> {
    const result = await db.insert(channelVariantOverrides)
      .values(data)
      .onConflictDoUpdate({
        target: [channelVariantOverrides.channelId, channelVariantOverrides.productVariantId],
        set: {
          nameOverride: data.nameOverride,
          skuOverride: data.skuOverride,
          barcodeOverride: data.barcodeOverride,
          weightOverride: data.weightOverride,
          isListed: data.isListed,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async deleteChannelVariantOverride(channelId: number, productVariantId: number): Promise<boolean> {
    const result = await db.delete(channelVariantOverrides)
      .where(and(
        eq(channelVariantOverrides.channelId, channelId),
        eq(channelVariantOverrides.productVariantId, productVariantId)
      ))
      .returning();
    return result.length > 0;
  },

  async getChannelPricing(channelId: number, productVariantId: number): Promise<ChannelPricing | undefined> {
    const result = await db.select().from(channelPricing)
      .where(and(
        eq(channelPricing.channelId, channelId),
        eq(channelPricing.productVariantId, productVariantId)
      ));
    return result[0];
  },

  async getChannelPricingByProduct(channelId: number, productId: number): Promise<ChannelPricing[]> {
    return await db.select().from(channelPricing)
      .where(and(
        eq(channelPricing.channelId, channelId),
        sql`${channelPricing.productVariantId} IN (
          SELECT id FROM product_variants WHERE product_id = ${productId}
        )`
      ));
  },

  async upsertChannelPricing(data: InsertChannelPricing): Promise<ChannelPricing> {
    const result = await db.insert(channelPricing)
      .values(data)
      .onConflictDoUpdate({
        target: [channelPricing.channelId, channelPricing.productVariantId],
        set: {
          price: data.price,
          compareAtPrice: data.compareAtPrice,
          cost: data.cost,
          currency: data.currency,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async deleteChannelPricing(channelId: number, productVariantId: number): Promise<boolean> {
    const result = await db.delete(channelPricing)
      .where(and(
        eq(channelPricing.channelId, channelId),
        eq(channelPricing.productVariantId, productVariantId)
      ))
      .returning();
    return result.length > 0;
  },

  async getChannelListing(channelId: number, productVariantId: number): Promise<ChannelListing | undefined> {
    const result = await db.select().from(channelListings)
      .where(and(
        eq(channelListings.channelId, channelId),
        eq(channelListings.productVariantId, productVariantId)
      ));
    return result[0];
  },

  async getChannelListingsByProduct(channelId: number, productId: number): Promise<ChannelListing[]> {
    return await db.select().from(channelListings)
      .where(and(
        eq(channelListings.channelId, channelId),
        sql`${channelListings.productVariantId} IN (
          SELECT id FROM product_variants WHERE product_id = ${productId}
        )`
      ));
  },

  async upsertChannelListing(data: InsertChannelListing): Promise<ChannelListing> {
    const result = await db.insert(channelListings)
      .values(data)
      .onConflictDoUpdate({
        target: [channelListings.channelId, channelListings.productVariantId],
        set: {
          externalProductId: data.externalProductId,
          externalVariantId: data.externalVariantId,
          externalSku: data.externalSku,
          externalUrl: data.externalUrl,
          lastSyncedQty: data.lastSyncedQty,
          lastSyncedPrice: data.lastSyncedPrice,
          lastSyncedAt: data.lastSyncedAt,
          syncStatus: data.syncStatus,
          syncError: data.syncError,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async getChannelListingByExternalId(channelId: number, externalProductId: string): Promise<ChannelListing | undefined> {
    const result = await db.select().from(channelListings)
      .where(and(
        eq(channelListings.channelId, channelId),
        eq(channelListings.externalProductId, externalProductId)
      ));
    return result[0];
  },

  async getChannelAssetOverridesByProduct(channelId: number, productId: number): Promise<ChannelAssetOverride[]> {
    return await db.select().from(channelAssetOverrides)
      .where(and(
        eq(channelAssetOverrides.channelId, channelId),
        sql`${channelAssetOverrides.productAssetId} IN (
          SELECT id FROM product_assets WHERE product_id = ${productId}
        )`
      ));
  },

  async upsertChannelAssetOverride(data: InsertChannelAssetOverride): Promise<ChannelAssetOverride> {
    const result = await db.insert(channelAssetOverrides)
      .values(data)
      .onConflictDoUpdate({
        target: [channelAssetOverrides.channelId, channelAssetOverrides.productAssetId],
        set: {
          urlOverride: data.urlOverride,
          altTextOverride: data.altTextOverride,
          positionOverride: data.positionOverride,
          isIncluded: data.isIncluded,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async deleteChannelAssetOverride(channelId: number, productAssetId: number): Promise<boolean> {
    const result = await db.delete(channelAssetOverrides)
      .where(and(
        eq(channelAssetOverrides.channelId, channelId),
        eq(channelAssetOverrides.productAssetId, productAssetId)
      ))
      .returning();
    return result.length > 0;
  },

  async getChannelListingsByChannel(channelId: number): Promise<ChannelListing[]> {
    return db.select().from(channelListings).where(eq(channelListings.channelId, channelId));
  },

  async replaceChannelProductLines(channelId: number, productLineIds: number[]): Promise<void> {
    await db.delete(channelProductLines).where(eq(channelProductLines.channelId, channelId));
    if (productLineIds.length > 0) {
      await db.insert(channelProductLines).values(
        productLineIds.map((plId: number) => ({ channelId, productLineId: plId }))
      ).onConflictDoNothing();
    }
  },

  async getChannelProductLinesForChannel(channelId: number): Promise<{ id: number; code: string; name: string; isActive: boolean | null }[]> {
    return db
      .select({ id: productLines.id, code: productLines.code, name: productLines.name, isActive: channelProductLines.isActive })
      .from(channelProductLines)
      .innerJoin(productLines, eq(productLines.id, channelProductLines.productLineId))
      .where(eq(channelProductLines.channelId, channelId))
      .orderBy(productLines.sortOrder, productLines.name);
  },
};
