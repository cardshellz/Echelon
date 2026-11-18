import { and, eq, sql } from "drizzle-orm";
import {
  channelConnections,
  channelVariantOverrides,
  ebayCategoryAspects,
  ebayListingRules,
  ebayProductAspectOverrides,
  ebayTypeAspectDefaults,
} from "@shared/schema";
import { db, pool } from "../../../db";

export async function insertDefaultEbayChannelConnection(
  channelId: number,
  database: any = db,
) {
  const [newConn] = await database
    .insert(channelConnections)
    .values({
      channelId,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return newConn;
}

export async function mergeEbayChannelConnectionMerchantLocation(
  connectionId: number,
  locationMetadata: Record<string, unknown>,
  database: any = db,
): Promise<void> {
  await database
    .update(channelConnections)
    .set({
      metadata: sql`COALESCE(${channelConnections.metadata}, '{}'::jsonb) || ${JSON.stringify(locationMetadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(channelConnections.id, connectionId));
}

export async function insertEbayListingRuleRecord(
  values: typeof ebayListingRules.$inferInsert,
  database: any = db,
) {
  const [rule] = await database
    .insert(ebayListingRules)
    .values(values)
    .returning();
  return rule;
}

export async function updateEbayListingRuleRecord(
  ruleId: number,
  channelId: number,
  updateData: Partial<typeof ebayListingRules.$inferInsert>,
  database: any = db,
) {
  const [updated] = await database
    .update(ebayListingRules)
    .set(updateData)
    .where(
      and(
        eq(ebayListingRules.id, ruleId),
        eq(ebayListingRules.channelId, channelId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function deleteEbayListingRuleRecord(
  ruleId: number,
  database: any = db,
): Promise<void> {
  await database
    .delete(ebayListingRules)
    .where(eq(ebayListingRules.id, ruleId));
}

export async function upsertEbayCategoryTypeListingEnabled(
  channelId: number,
  productTypeSlug: string,
  listingEnabled: boolean,
  queryPool: Pick<typeof pool, "connect"> = pool,
): Promise<void> {
  const client = await queryPool.connect();
  try {
    await client.query(
      `
        INSERT INTO ebay_category_mappings (
          channel_id, product_type_slug, listing_enabled, created_at, updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (channel_id, product_type_slug)
        DO UPDATE SET listing_enabled = EXCLUDED.listing_enabled, updated_at = NOW()
      `,
      [channelId, productTypeSlug, listingEnabled],
    );
  } finally {
    client.release();
  }
}

export async function markChannelListingReconcileDeleted(
  listingId: number,
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
): Promise<void> {
  await client.query(
    `UPDATE channel_listings SET sync_status = 'deleted', sync_error = 'Inventory item not found on eBay', updated_at = NOW()
     WHERE id = $1`,
    [listingId],
  );
}

export async function markChannelListingReconcileEnded(
  listingId: number,
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
): Promise<void> {
  await client.query(
    `UPDATE channel_listings SET sync_status = 'ended', sync_error = 'Offer no longer active on eBay', updated_at = NOW()
     WHERE id = $1`,
    [listingId],
  );
}

export async function upsertChannelVariantListedOverrideInTx(
  tx: any,
  channelId: number,
  variantId: number,
  isListed: number,
): Promise<void> {
  await tx
    .insert(channelVariantOverrides)
    .values({
      channelId,
      productVariantId: variantId,
      isListed,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [channelVariantOverrides.channelId, channelVariantOverrides.productVariantId],
      set: {
        isListed,
        updatedAt: new Date(),
      },
    });
}

export async function markChannelVariantListingPendingForRelist(
  channelId: number,
  variantId: number,
  queryPool: Pick<typeof pool, "query"> = pool,
): Promise<void> {
  await queryPool.query(
    `
      UPDATE channels.channel_listings
      SET sync_status = 'pending',
          sync_error = NULL,
          updated_at = NOW()
      WHERE channel_id = $1::integer
        AND product_variant_id = $2::integer
        AND sync_status IN ('ended', 'deleted')
    `,
    [channelId, variantId],
  );
}

export async function markChannelVariantListingZeroed(
  channelId: number,
  variantId: number,
  queryPool: Pick<typeof pool, "query"> = pool,
): Promise<void> {
  await queryPool.query(
    `
      UPDATE channels.channel_listings
      SET sync_status = 'synced',
          sync_error = NULL,
          last_synced_qty = 0,
          last_synced_at = NOW(),
          updated_at = NOW()
      WHERE channel_id = $1::integer
        AND product_variant_id = $2::integer
    `,
    [channelId, variantId],
  );
}

export async function markChannelVariantListingSyncError(
  channelId: number,
  variantId: number,
  message: string,
  queryPool: Pick<typeof pool, "query"> = pool,
): Promise<void> {
  await queryPool.query(
    `
      UPDATE channels.channel_listings
      SET sync_status = 'error',
          sync_error = $3::text,
          updated_at = NOW()
      WHERE channel_id = $1::integer
        AND product_variant_id = $2::integer
    `,
    [channelId, variantId, message],
  );
}

export interface EbayCategoryAspectSeedItem {
  name: string;
  required: boolean;
  mode: string;
  usage: string;
  values: string[] | null;
  order: number;
}

export async function replaceEbayCategoryAspects(
  categoryId: string,
  aspects: readonly EbayCategoryAspectSeedItem[],
  database: typeof db = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(ebayCategoryAspects)
      .where(eq(ebayCategoryAspects.categoryId, categoryId));
    if (aspects.length > 0) {
      await tx.insert(ebayCategoryAspects).values(
        aspects.map((a) => ({
          categoryId,
          aspectName: a.name,
          aspectRequired: a.required,
          aspectMode: a.mode,
          aspectUsage: a.usage,
          aspectValues: a.values,
          aspectOrder: a.order,
          fetchedAt: new Date(),
        })),
      );
    }
  });
}

export async function replaceEbayTypeAspectDefaults(
  productTypeSlug: string,
  entries: ReadonlyArray<readonly [string, string]>,
  database: typeof db = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(ebayTypeAspectDefaults)
      .where(eq(ebayTypeAspectDefaults.productTypeSlug, productTypeSlug));
    if (entries.length > 0) {
      await tx.insert(ebayTypeAspectDefaults).values(
        entries.map(([name, value]) => ({
          productTypeSlug,
          aspectName: name,
          aspectValue: value,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    }
  });
}

export async function replaceEbayProductAspectOverrides(
  productId: number,
  entries: ReadonlyArray<readonly [string, string]>,
  database: typeof db = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(ebayProductAspectOverrides)
      .where(eq(ebayProductAspectOverrides.productId, productId));
    if (entries.length > 0) {
      await tx.insert(ebayProductAspectOverrides).values(
        entries.map(([name, value]) => ({
          productId,
          aspectName: name,
          aspectValue: value,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    }
  });
}
