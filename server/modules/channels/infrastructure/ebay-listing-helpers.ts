import { db } from "../../../db";
import { resolveChannelListingPrice } from "../channel-pricing-resolver";
export { applyPricingRule } from "../channel-pricing-resolver";
type EchelonDb = typeof db;

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
