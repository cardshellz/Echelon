import { eq } from "drizzle-orm";
import {
  channelListings,
  channelProductOverrides,
  channelVariantOverrides,
  products,
  productVariants,
} from "@shared/schema";
import { db, pool } from "../../db";
import { EBAY_CHANNEL_ID, ebayApiRequest, getAuthService } from "./ebay-utils";
export {
  isProductEffectivelyListed,
  isVariantEffectivelyListed,
  type EffectiveListingInput,
} from "./ebay-listing-state-core";

type DbLike = typeof db;

export interface EbayRemoteTransitionResult {
  action:
    | "none"
    | "withdraw_inventory_item_group"
    | "withdraw_offer"
    | "withdraw_offers"
    | "zero_variant_offer"
    | "zero_variant_inventory_item";
  affectedListings: number;
  detail: string;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message.substring(0, 1000) : String(err).substring(0, 1000);
}

export async function setEbayProductListingIntent(
  productId: number,
  listed: boolean,
  dbArg: DbLike = db,
): Promise<void> {
  assertPositiveId(productId, "productId");
  const excluded = !listed;
  const isListed = listed ? 1 : 0;

  await dbArg.transaction(async (tx: any) => {
    await tx
      .update(products)
      .set({ ebayListingExcluded: excluded })
      .where(eq(products.id, productId));

    await tx
      .insert(channelProductOverrides)
      .values({
        channelId: EBAY_CHANNEL_ID,
        productId,
        isListed,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [channelProductOverrides.channelId, channelProductOverrides.productId],
        set: {
          isListed,
          updatedAt: new Date(),
        },
      });
  });
}

export async function setEbayVariantListingIntent(
  variantId: number,
  listed: boolean,
  dbArg: DbLike = db,
): Promise<void> {
  assertPositiveId(variantId, "variantId");
  const excluded = !listed;
  const isListed = listed ? 1 : 0;

  await dbArg.transaction(async (tx: any) => {
    await tx
      .update(productVariants)
      .set({ ebayListingExcluded: excluded })
      .where(eq(productVariants.id, variantId));

    await tx
      .insert(channelVariantOverrides)
      .values({
        channelId: EBAY_CHANNEL_ID,
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
  });
}

export async function markEbayProductListingsPendingForRelist(productId: number): Promise<void> {
  assertPositiveId(productId, "productId");
  await pool.query(
    `
      UPDATE channels.channel_listings cl
      SET sync_status = 'pending',
          sync_error = NULL,
          updated_at = NOW()
      FROM catalog.product_variants pv
      WHERE cl.product_variant_id = pv.id
        AND cl.channel_id = $1::integer
        AND pv.product_id = $2::integer
        AND cl.sync_status IN ('ended', 'deleted')
    `,
    [EBAY_CHANNEL_ID, productId],
  );
}

export async function markEbayVariantListingPendingForRelist(variantId: number): Promise<void> {
  assertPositiveId(variantId, "variantId");
  await pool.query(
    `
      UPDATE channels.channel_listings
      SET sync_status = 'pending',
          sync_error = NULL,
          updated_at = NOW()
      WHERE channel_id = $1::integer
        AND product_variant_id = $2::integer
        AND sync_status IN ('ended', 'deleted')
    `,
    [EBAY_CHANNEL_ID, variantId],
  );
}

async function markProductListingsEnded(productId: number): Promise<void> {
  await pool.query(
    `
      UPDATE channels.channel_listings cl
      SET sync_status = 'ended',
          sync_error = NULL,
          last_synced_qty = 0,
          last_synced_at = NOW(),
          updated_at = NOW()
      FROM catalog.product_variants pv
      WHERE cl.product_variant_id = pv.id
        AND cl.channel_id = $1::integer
        AND pv.product_id = $2::integer
    `,
    [EBAY_CHANNEL_ID, productId],
  );
}

async function markProductListingsError(productId: number, message: string): Promise<void> {
  await pool.query(
    `
      UPDATE channels.channel_listings cl
      SET sync_status = 'error',
          sync_error = $3::text,
          updated_at = NOW()
      FROM catalog.product_variants pv
      WHERE cl.product_variant_id = pv.id
        AND cl.channel_id = $1::integer
        AND pv.product_id = $2::integer
    `,
    [EBAY_CHANNEL_ID, productId, message],
  );
}

async function markVariantListingZeroed(variantId: number): Promise<void> {
  await pool.query(
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
    [EBAY_CHANNEL_ID, variantId],
  );
}

async function markVariantListingError(variantId: number, message: string): Promise<void> {
  await pool.query(
    `
      UPDATE channels.channel_listings
      SET sync_status = 'error',
          sync_error = $3::text,
          updated_at = NOW()
      WHERE channel_id = $1::integer
        AND product_variant_id = $2::integer
    `,
    [EBAY_CHANNEL_ID, variantId, message],
  );
}

export async function withdrawEbayProductListings(productId: number): Promise<EbayRemoteTransitionResult> {
  assertPositiveId(productId, "productId");
  const result = await pool.query(
    `
      SELECT
        p.id,
        p.sku,
        COUNT(pv.id) FILTER (WHERE pv.sku IS NOT NULL AND pv.is_active = TRUE) AS active_variant_count,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT cl.external_product_id), NULL) AS listing_ids,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT cl.external_variant_id), NULL) AS offer_ids
      FROM catalog.products p
      LEFT JOIN catalog.product_variants pv ON pv.product_id = p.id
      LEFT JOIN channels.channel_listings cl
        ON cl.product_variant_id = pv.id
       AND cl.channel_id = $1::integer
       AND cl.sync_status = 'synced'
      WHERE p.id = $2::integer
      GROUP BY p.id, p.sku
    `,
    [EBAY_CHANNEL_ID, productId],
  );

  if (result.rowCount === 0) {
    throw new Error(`Product ${productId} not found`);
  }

  const row = result.rows[0];
  const offerIds: string[] = row.offer_ids ?? [];
  const listingIds: string[] = row.listing_ids ?? [];
  if (offerIds.length === 0 && listingIds.length === 0) {
    await markProductListingsEnded(productId);
    return { action: "none", affectedListings: 0, detail: "No active eBay offer/listing IDs found" };
  }

  const authService = getAuthService();
  if (!authService) {
    throw new Error("eBay OAuth not configured");
  }

  const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
  const groupKey = row.sku || `PROD-${productId}`;
  const activeVariantCount = Number(row.active_variant_count ?? 0);

  try {
    if (activeVariantCount > 1) {
      await ebayApiRequest(
        "POST",
        "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
        accessToken,
        { inventoryItemGroupKey: groupKey, marketplaceId: "EBAY_US" },
      );
      await markProductListingsEnded(productId);
      return {
        action: "withdraw_inventory_item_group",
        affectedListings: listingIds.length || offerIds.length,
        detail: `Withdrew inventory item group ${groupKey}`,
      };
    }

    for (const offerId of offerIds) {
      await ebayApiRequest("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, accessToken);
    }
    await markProductListingsEnded(productId);
    return {
      action: offerIds.length > 1 ? "withdraw_offers" : "withdraw_offer",
      affectedListings: offerIds.length,
      detail: `Withdrew ${offerIds.length} eBay offer(s)`,
    };
  } catch (err) {
    const message = normalizeError(err);
    await markProductListingsError(productId, message);
    throw err;
  }
}

export async function zeroEbayVariantListing(variantId: number): Promise<EbayRemoteTransitionResult> {
  assertPositiveId(variantId, "variantId");
  const result = await pool.query(
    `
      SELECT
        pv.id,
        pv.sku,
        COALESCE(cl.external_variant_id, '') AS offer_id,
        COALESCE(cl.external_sku, pv.sku) AS external_sku
      FROM catalog.product_variants pv
      LEFT JOIN channels.channel_listings cl
        ON cl.product_variant_id = pv.id
       AND cl.channel_id = $1::integer
      WHERE pv.id = $2::integer
      ORDER BY CASE WHEN cl.sync_status = 'synced' THEN 0 ELSE 1 END, cl.id DESC
      LIMIT 1
    `,
    [EBAY_CHANNEL_ID, variantId],
  );

  if (result.rowCount === 0) {
    throw new Error(`Variant ${variantId} not found`);
  }

  const row = result.rows[0];
  const sku = row.external_sku || row.sku;
  const offerId = row.offer_id || null;
  if (!sku) {
    await markVariantListingZeroed(variantId);
    return { action: "none", affectedListings: 0, detail: "No eBay SKU found for this variant" };
  }

  const authService = getAuthService();
  if (!authService) {
    throw new Error("eBay OAuth not configured");
  }

  const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
  try {
    if (offerId) {
      await ebayApiRequest(
        "POST",
        "/sell/inventory/v1/bulk_update_price_quantity",
        accessToken,
        {
          requests: [
            {
              sku,
              shipToLocationAvailability: { quantity: 0 },
              offers: [{ offerId, availableQuantity: 0 }],
            },
          ],
        },
      );
      await markVariantListingZeroed(variantId);
      return {
        action: "zero_variant_offer",
        affectedListings: 1,
        detail: `Set eBay offer ${offerId} quantity to zero`,
      };
    }

    try {
      const inventoryItem = await ebayApiRequest(
        "GET",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        accessToken,
      );
      const { sku: _skuFromEbay, ...inventoryItemBody } = inventoryItem ?? {};
      await ebayApiRequest(
        "PUT",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        accessToken,
        {
          ...inventoryItemBody,
          availability: {
            ...(inventoryItemBody.availability ?? {}),
            shipToLocationAvailability: { quantity: 0 },
          },
        },
      );
      await markVariantListingZeroed(variantId);
      return {
        action: "zero_variant_inventory_item",
        affectedListings: 1,
        detail: `Set eBay inventory item ${sku} quantity to zero`,
      };
    } catch (inventoryErr: any) {
      if (String(inventoryErr.message || "").includes("failed (404)")) {
        await markVariantListingZeroed(variantId);
        return {
          action: "none",
          affectedListings: 0,
          detail: `No active eBay offer or inventory item found for SKU ${sku}`,
        };
      }
      throw inventoryErr;
    }
  } catch (err) {
    const message = normalizeError(err);
    await markVariantListingError(variantId, message);
    throw err;
  }
}
