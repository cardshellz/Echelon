import { eq } from "drizzle-orm";
import {
  channelListings,
  channelVariantOverrides,
  productVariants,
} from "@shared/schema";
import { db, pool } from "../../db";
import { EBAY_CHANNEL_ID, getAuthService } from "./ebay-utils";
import { createEbayRouteListingLifecycleClient } from "./ebay-listing-connector-client";
export {
  isProductEffectivelyListed,
  isVariantEffectivelyListed,
  isVariantSellable,
  type EffectiveListingInput,
  type VariantSellabilityInput,
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
  const ebayClient = createEbayRouteListingLifecycleClient({ accessToken });
  try {
    if (offerId) {
      await ebayClient.bulkUpdatePriceQuantity({
        requests: [
          {
            sku,
            shipToLocationAvailability: { quantity: 0 },
            offers: [{ offerId, availableQuantity: 0 }],
          },
        ],
      });
      await markVariantListingZeroed(variantId);
      return {
        action: "zero_variant_offer",
        affectedListings: 1,
        detail: `Set eBay offer ${offerId} quantity to zero`,
      };
    }

    try {
      const inventoryItem = await ebayClient.getInventoryItem(sku);
      if (!inventoryItem) {
        await markVariantListingZeroed(variantId);
        return {
          action: "none",
          affectedListings: 0,
          detail: `No active eBay offer or inventory item found for SKU ${sku}`,
        };
      }
      const { sku: _skuFromEbay, ...inventoryItemBody } = inventoryItem ?? {};
      await ebayClient.createOrReplaceInventoryItem(
        sku,
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
