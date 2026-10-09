import { db } from "../../../db";
import { EBAY_CHANNEL_ID } from "./ebay-api-runtime";
import { channelListings, productVariants } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { resolveChannelListingPrice } from "../channel-pricing-resolver";
export { applyPricingRule } from "../channel-pricing-resolver";
type EchelonDb = typeof db;

export async function upsertChannelListing(
  dbArg: EchelonDb,
  channelId: number,
  productVariantId: number,
  data: {
    externalProductId?: string | null;
    externalVariantId?: string | null;
    externalSku?: string | null;
    externalUrl?: string | null;
    syncStatus?: string;
    syncError?: string | null;
    lastSyncedPrice?: number | null;
    lastSyncedQty?: number | null;
  },
): Promise<void> {
  await dbArg
    .insert(channelListings)
    .values({
      channelId,
      productVariantId,
      externalProductId: data.externalProductId || null,
      externalVariantId: data.externalVariantId || null,
      externalSku: data.externalSku || null,
      externalUrl: data.externalUrl || null,
      syncStatus: data.syncStatus || "pending",
      syncError: data.syncError || null,
      lastSyncedPrice: data.lastSyncedPrice ?? null,
      lastSyncedQty: data.lastSyncedQty ?? null,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [channelListings.channelId, channelListings.productVariantId],
      set: {
        externalProductId: sql`COALESCE(EXCLUDED.external_product_id, channel_listings.external_product_id)`,
        externalVariantId: sql`COALESCE(EXCLUDED.external_variant_id, channel_listings.external_variant_id)`,
        externalSku: sql`COALESCE(EXCLUDED.external_sku, channel_listings.external_sku)`,
        externalUrl: sql`COALESCE(EXCLUDED.external_url, channel_listings.external_url)`,
        syncStatus: data.syncStatus || "pending",
        syncError: data.syncError || null,
        lastSyncedPrice: data.lastSyncedPrice ?? null,
        lastSyncedQty: data.lastSyncedQty ?? null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Push Error Helpers — store/clear per-product push errors
// ---------------------------------------------------------------------------

/**
 * Store the last push error for a product (across all its variants).
 * Uses the first variant's channel_listing row to store the error.
 */
export async function upsertPushError(
  dbArg: EchelonDb,
  channelId: number,
  productId: number,
  error: string,
): Promise<void> {
  // Find all variant IDs for this product
  const variants = await dbArg
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        sql`${productVariants.sku} IS NOT NULL`,
        eq(productVariants.isActive, true),
        eq(productVariants.salesEligibility, "sellable"),
      ),
    )
    .limit(1);

  if (variants.length > 0) {
    const variantId = variants[0].id;
    await upsertChannelListing(dbArg, channelId, variantId, {
      syncStatus: "error",
      syncError: error.substring(0, 1000),
    });
  }
}

/**
 * Clear push error for a product (across all its variants).
 */
export async function clearPushError(
  dbArg: EchelonDb,
  channelId: number,
  productId: number,
): Promise<void> {
  // Subquery: get all variant IDs for the product
  const variants = await dbArg
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  if (variants.length === 0) return;

  const variantIds = variants.map((v: any) => v.id);

  await dbArg
    .update(channelListings)
    .set({ syncError: null })
    .where(
      and(
        eq(channelListings.channelId, channelId),
        inArray(channelListings.productVariantId, variantIds),
      ),
    );
}

// ---------------------------------------------------------------------------
// Price Resolution — hierarchical pricing rules
// ---------------------------------------------------------------------------

/**
 * Resolve the effective channel price for a variant.
 * Compatibility wrapper around the shared channel listing price resolver.
 */
export async function resolveChannelPrice(
  dbArg: EchelonDb,
  channelId: number,
  productId: number,
  variantId: number,
  basePriceCents: number | null | undefined,
): Promise<number> {
  const resolution = await resolveChannelListingPrice(dbArg, {
    channelId,
    productId,
    variantId,
    fallbackCatalogPriceCents: basePriceCents,
  });
  return resolution.priceCents ?? 0;
}
// ---------------------------------------------------------------------------
// Variation Aspect Name Detection
// ---------------------------------------------------------------------------

/**
 * Determine the eBay variation aspect name from variant data.
 * Uses option1_name if available and consistent, otherwise infers from values.
 */
export function determineVariationAspectName(variants: any[]): string {
  // Check if all variants have the same option1_name
  const option1Names = variants
    .map((v) => v.option1_name)
    .filter((n) => n && n.trim());

  if (option1Names.length > 0) {
    const uniqueNames = [...new Set(option1Names)];
    if (uniqueNames.length === 1) {
      return uniqueNames[0];
    }
  }

  // Infer from values: check if they look like quantities
  const values = variants.map((v) => v.option1_value || v.name || "");
  const allNumeric = values.every((v) => /^\d+/.test(v));
  if (allNumeric) return "Pack Size";

  return "Style";
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sync Active Listings — updates prices, quantities, policies, aspects
// ---------------------------------------------------------------------------

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
