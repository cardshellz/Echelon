import {
  channelFeeds,
  channelListings,
  type ChannelFeed,
  type InsertChannelFeed,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";

export async function updateChannelFeedByIdInChannels(
  executor: { update: (...args: any[]) => any },
  id: number,
  feed: InsertChannelFeed,
  now: Date = new Date(),
): Promise<ChannelFeed> {
  const result = await executor
    .update(channelFeeds)
    .set({ ...feed, updatedAt: now })
    .where(eq(channelFeeds.id, id))
    .returning();
  return result[0];
}

export async function insertChannelFeedInChannels(
  executor: { insert: (...args: any[]) => any },
  feed: InsertChannelFeed,
): Promise<ChannelFeed> {
  const result = await executor.insert(channelFeeds).values(feed).returning();
  return result[0];
}

export async function updateChannelFeedSyncStatusByIdInChannels(
  executor: { update: (...args: any[]) => any },
  id: number,
  qty: number,
  now: Date = new Date(),
): Promise<ChannelFeed | null> {
  const result = await executor
    .update(channelFeeds)
    .set({
      lastSyncedAt: now,
      lastSyncedQty: qty,
      updatedAt: now,
    })
    .where(eq(channelFeeds.id, id))
    .returning();
  return result[0] || null;
}

export async function deactivateActiveChannelFeedsByVariantIdInChannels(
  executor: { update: (...args: any[]) => any },
  variantId: number,
  now: Date = new Date(),
): Promise<number> {
  const result = await executor
    .update(channelFeeds)
    .set({ isActive: 0, updatedAt: now })
    .where(and(eq(channelFeeds.productVariantId, variantId), eq(channelFeeds.isActive, 1)))
    .returning({ id: channelFeeds.id });
  return result.length;
}

export async function deactivateAllChannelFeedsByVariantIdInChannels(
  executor: { update: (...args: any[]) => any },
  variantId: number,
  now: Date = new Date(),
): Promise<void> {
  await executor
    .update(channelFeeds)
    .set({ isActive: 0, updatedAt: now })
    .where(eq(channelFeeds.productVariantId, variantId));
}

export async function upsertShopifyVariantFeedAndListingLinkInTx(
  tx: { update: (...args: any[]) => any; insert: (...args: any[]) => any },
  input: {
    channelId: number;
    variantId: number;
    shopifyProductId: string;
    shopifyVariantId: string;
    shopifyInventoryItemId: string | null;
    effectiveSku: string | null;
    now?: Date;
  },
): Promise<{ feedIds: number[]; listingIds: number[] }> {
  const timestamp = input.now ?? new Date();
  const updatedFeeds = await tx
    .update(channelFeeds)
    .set({
      channelVariantId: input.shopifyVariantId,
      channelProductId: input.shopifyProductId,
      channelSku: input.effectiveSku,
      channelInventoryItemId: input.shopifyInventoryItemId,
      isActive: 1,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(channelFeeds.channelId, input.channelId),
        eq(channelFeeds.productVariantId, input.variantId),
        eq(channelFeeds.channelType, "shopify"),
      ),
    )
    .returning({ id: channelFeeds.id });

  let feedIds = updatedFeeds.map((row: { id: number }) => row.id);
  if (feedIds.length === 0) {
    const insertedFeeds = await tx
      .insert(channelFeeds)
      .values({
        channelId: input.channelId,
        productVariantId: input.variantId,
        channelType: "shopify",
        channelVariantId: input.shopifyVariantId,
        channelProductId: input.shopifyProductId,
        channelSku: input.effectiveSku,
        channelInventoryItemId: input.shopifyInventoryItemId,
        isActive: 1,
      })
      .returning({ id: channelFeeds.id });
    feedIds = insertedFeeds.map((row: { id: number }) => row.id);
  }

  const updatedListings = await tx
    .update(channelListings)
    .set({
      externalProductId: input.shopifyProductId,
      externalVariantId: input.shopifyVariantId,
      externalSku: input.effectiveSku,
      syncStatus: "synced",
      syncError: null,
      lastSyncedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(channelListings.channelId, input.channelId),
        eq(channelListings.productVariantId, input.variantId),
      ),
    )
    .returning({ id: channelListings.id });

  let listingIds = updatedListings.map((row: { id: number }) => row.id);
  if (listingIds.length === 0) {
    const insertedListings = await tx
      .insert(channelListings)
      .values({
        channelId: input.channelId,
        productVariantId: input.variantId,
        externalProductId: input.shopifyProductId,
        externalVariantId: input.shopifyVariantId,
        externalSku: input.effectiveSku,
        syncStatus: "synced",
        lastSyncedAt: timestamp,
      })
      .returning({ id: channelListings.id });
    listingIds = insertedListings.map((row: { id: number }) => row.id);
  }

  return { feedIds, listingIds };
}

export async function disableShopifyVariantFeedsAndResetListingsInTx(
  tx: { update: (...args: any[]) => any },
  input: {
    channelId: number;
    variantIds: number[];
    clearChannelVariantId: boolean;
    syncError: string;
    now: Date;
  },
): Promise<{ disabledFeeds: Array<{ id: number }>; resetListings: Array<{ id: number }> }> {
  if (input.variantIds.length === 0) {
    return { disabledFeeds: [], resetListings: [] };
  }

  const feedUpdates: Record<string, unknown> = {
    channelProductId: null,
    channelInventoryItemId: null,
    isActive: 0,
    lastSyncedQty: null,
    consecutivePushFailures: 0,
    quarantinedAt: null,
    quarantineReason: null,
    updatedAt: input.now,
  };
  if (input.clearChannelVariantId) {
    feedUpdates.channelVariantId = null;
  }

  const disabledFeeds = await tx
    .update(channelFeeds)
    .set(feedUpdates)
    .where(
      and(
        eq(channelFeeds.channelId, input.channelId),
        eq(channelFeeds.channelType, "shopify"),
        inArray(channelFeeds.productVariantId, input.variantIds),
      ),
    )
    .returning({ id: channelFeeds.id });

  const resetListings = await tx
    .update(channelListings)
    .set({
      externalProductId: null,
      externalVariantId: null,
      externalUrl: null,
      syncStatus: "error",
      syncError: input.syncError,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(channelListings.channelId, input.channelId),
        inArray(channelListings.productVariantId, input.variantIds),
      ),
    )
    .returning({ id: channelListings.id });

  return { disabledFeeds, resetListings };
}

export async function disableDelistedShopifyVariantFeedAndListingInTx(
  tx: { update: (...args: any[]) => any },
  input: {
    channelId: number;
    variantId: number;
    syncError: string;
    writtenAt: Date;
  },
): Promise<void> {
  await tx
    .update(channelFeeds)
    .set({
      channelProductId: null,
      channelInventoryItemId: null,
      isActive: 0,
      lastSyncedQty: null,
      consecutivePushFailures: 0,
      quarantinedAt: null,
      quarantineReason: null,
      updatedAt: input.writtenAt,
    })
    .where(
      and(
        eq(channelFeeds.channelId, input.channelId),
        eq(channelFeeds.channelType, "shopify"),
        eq(channelFeeds.productVariantId, input.variantId),
      ),
    );

  await tx
    .update(channelListings)
    .set({
      externalProductId: null,
      externalVariantId: null,
      externalUrl: null,
      syncStatus: "error",
      syncError: input.syncError,
      updatedAt: input.writtenAt,
    })
    .where(
      and(
        eq(channelListings.channelId, input.channelId),
        eq(channelListings.productVariantId, input.variantId),
      ),
    );
}

export async function upsertRepairedShopifyVariantFeedAndListingInTx(
  tx: { update: (...args: any[]) => any; insert: (...args: any[]) => any },
  input: {
    channelId: number;
    variantId: number;
    targetProductId: string;
    remoteVariantId: string;
    remoteInventoryItemId: string | null;
    channelSku: string | null;
    writtenAt: Date;
  },
): Promise<{
  updatedFeedCount: number;
  createdFeedCount: number;
  updatedListingCount: number;
  createdListingCount: number;
}> {
  let updatedFeedCount = 0;
  let createdFeedCount = 0;
  let updatedListingCount = 0;
  let createdListingCount = 0;

  const updatedFeeds = await tx
    .update(channelFeeds)
    .set({
      channelType: "shopify",
      channelProductId: input.targetProductId,
      channelVariantId: input.remoteVariantId,
      channelInventoryItemId: input.remoteInventoryItemId,
      channelSku: input.channelSku,
      isActive: 1,
      consecutivePushFailures: 0,
      quarantinedAt: null,
      quarantineReason: null,
      updatedAt: input.writtenAt,
    })
    .where(
      and(
        eq(channelFeeds.channelId, input.channelId),
        eq(channelFeeds.channelType, "shopify"),
        eq(channelFeeds.productVariantId, input.variantId),
      ),
    )
    .returning({ id: channelFeeds.id });
  if (updatedFeeds.length > 0) {
    updatedFeedCount += updatedFeeds.length;
  } else {
    await tx.insert(channelFeeds).values({
      channelId: input.channelId,
      productVariantId: input.variantId,
      channelType: "shopify",
      channelProductId: input.targetProductId,
      channelVariantId: input.remoteVariantId,
      channelInventoryItemId: input.remoteInventoryItemId,
      channelSku: input.channelSku,
      isActive: 1,
    });
    createdFeedCount += 1;
  }

  const updatedListings = await tx
    .update(channelListings)
    .set({
      externalProductId: input.targetProductId,
      externalVariantId: input.remoteVariantId,
      externalSku: input.channelSku,
      syncStatus: "synced",
      syncError: null,
      lastSyncedAt: input.writtenAt,
      updatedAt: input.writtenAt,
    })
    .where(
      and(
        eq(channelListings.channelId, input.channelId),
        eq(channelListings.productVariantId, input.variantId),
      ),
    )
    .returning({ id: channelListings.id });
  if (updatedListings.length > 0) {
    updatedListingCount += updatedListings.length;
  } else {
    await tx.insert(channelListings).values({
      channelId: input.channelId,
      productVariantId: input.variantId,
      externalProductId: input.targetProductId,
      externalVariantId: input.remoteVariantId,
      externalSku: input.channelSku,
      syncStatus: "synced",
      lastSyncedAt: input.writtenAt,
    });
    createdListingCount += 1;
  }

  return {
    updatedFeedCount,
    createdFeedCount,
    updatedListingCount,
    createdListingCount,
  };
}
