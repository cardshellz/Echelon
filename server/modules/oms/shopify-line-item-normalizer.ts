/**
 * Shopify Line Item Normalization
 *
 * Extracts line item data from Shopify webhooks with full discount splitting logic.
 * This matches the logic from shellz-club-app/server/routes/helpers.ts::normalizeShopifyLineItem
 * to ensure plan_discount_cents and coupon_discount_cents are calculated correctly.
 */

import { buildChannelLineDisplayName } from "./line-display-name";
import { normalizeShopifyLineVariantId } from "./domain/order-line-catalog-identity";

// Rewards redemption detection constants
const REWARDS_REDEMPTION_LABEL = process.env.REWARDS_REDEMPTION_LABEL || "Shellz Rewards Redemption";

export interface NormalizedLineItem {
  externalLineItemId: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  name: string | null;
  vendor: string | null;
  quantity: number;
  currentQuantity: number | null;
  fulfillableQuantity: number | null;
  paidPriceCents: number;
  retailPriceCents: number; // pre-discount unit price (Shopify line_items[].price)
  totalCents: number;
  discountCents: number;
  planDiscountCents: number;
  couponDiscountCents: number;
  requiresShipping: boolean;
}

interface LineDiscountSplit {
  planDiscountCents: number;
  couponDiscountCents: number;
}

interface PreparedLineItem {
  item: any;
  quantity: number;
  retailPriceCents: number;
  grossTotalCents: number;
  rawDiscount: LineDiscountSplit;
}

function readShopifyQuantity(raw: unknown): number | null {
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Missing or malformed commercial quantity stays unknown; remaining work
 * cannot supply evidence that purchased units were removed. */
export function readShopifyLineCurrentQuantity(
  lineItem: { current_quantity?: unknown } | null | undefined,
): number | null {
  return readShopifyQuantity(lineItem?.current_quantity);
}

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

function splitDiscountAllocations(item: any, discountApplications: any[]): LineDiscountSplit {
  const discountAllocations = item.discount_allocations || [];
  let planDiscountCents = 0;
  let couponDiscountCents = 0;

  // Split discounts into plan vs coupon based on type + rewards detection
  for (const alloc of discountAllocations) {
    const allocAmount = dollarsToCents(alloc.amount);
    const appIndex = alloc.discount_application_index;
    const app = discountApplications[appIndex];
    const appType = app?.type || app?.target_type || null;

    // Detect rewards redemptions (should go to coupon, not plan)
    const appCode = app?.code || app?.discount_code || app?.value || null;
    const appTitle = (app?.title || app?.description || app?.name || "").toString();
    const appTitleLower = appTitle.toLowerCase();
    const rewardsLabelLower = REWARDS_REDEMPTION_LABEL.toLowerCase();
    const isRewardsRedemption =
      (typeof appCode === "string" && appCode.toUpperCase().startsWith("SHELLZ-")) ||
      appTitleLower === rewardsLabelLower ||
      appTitleLower.includes(rewardsLabelLower) ||
      appTitleLower.includes("shellz rewards");

    // Routing logic
    if (appType === "manual" && !isRewardsRedemption) {
      planDiscountCents += allocAmount; // Member wholesale pricing
    } else {
      couponDiscountCents += allocAmount; // Coupons, automatic, rewards
    }
  }

  return { planDiscountCents, couponDiscountCents };
}

function buildNormalizedLineItem(
  prepared: PreparedLineItem,
  planDiscountCents: number,
  couponDiscountCents: number,
): NormalizedLineItem {
  const { item, quantity, retailPriceCents } = prepared;
  const totalDiscountCents = planDiscountCents + couponDiscountCents;

  // Calculate prices. totalCents preserves exact cents; paidPriceCents is an
  // average unit price for downstream systems that require a unit value.
  const paidPriceCents = Math.round(retailPriceCents - totalDiscountCents / quantity);
  const totalCents = retailPriceCents * quantity - totalDiscountCents;

  return {
    externalLineItemId: item.id?.toString() || "",
    externalProductId: item.product_id?.toString() || null,
    externalVariantId: normalizeShopifyLineVariantId(item.variant_id),
    sku: item.sku || null,
    title: buildChannelLineDisplayName({
      name: item.name,
      title: item.title,
      variantTitle: item.variant_title,
    }),
    variantTitle: item.variant_title || null,
    name: item.name || null,
    vendor: item.vendor || null,
    quantity,
    currentQuantity: readShopifyLineCurrentQuantity(item),
    fulfillableQuantity: readShopifyQuantity(item.fulfillable_quantity),
    paidPriceCents,
    retailPriceCents, // pre-discount unit price (Shopify line_items[].price)
    totalCents,
    discountCents: totalDiscountCents,
    planDiscountCents,
    couponDiscountCents,
    requiresShipping: item.requires_shipping !== false, // Shopify defaults to true
  };
}

/**
 * Normalizes a Shopify line item with full discount splitting logic.
 *
 * Discount splitting rules:
 * - "manual" discounts -> plan_discount_cents (member wholesale pricing)
 * - EXCEPT manual discounts with SHELLZ-* codes -> coupon_discount_cents (rewards redemptions)
 * - All other discount types -> coupon_discount_cents (discount codes, automatic, script)
 *
 * @param item - Shopify line_item object from webhook payload
 * @param discountApplications - discount_applications array from order payload
 * @param orderNumber - Order number from parent order
 * @returns Normalized line item with all required fields populated
 */
export function normalizeShopifyLineItem(
  item: any,
  discountApplications: any[],
  orderNumber?: string
): NormalizedLineItem {
  return normalizeShopifyLineItems([item], discountApplications, orderNumber)[0];
}

/**
 * Batch normalizes all line items from a Shopify order
 */
export function normalizeShopifyLineItems(
  lineItems: any[],
  discountApplications: any[],
  orderNumber?: string
): NormalizedLineItem[] {
  // Each line keeps exactly the discount Shopify allocated to it. Echelon only
  // converts units and labels discounts (plan vs coupon); it never moves them.
  // Moving donation/gift-card discounts onto other lines (6b336d74) priced a
  // fully discounted binder at -$1.00 and blocked OMS order 1071127's WMS sync.
  return lineItems.map((item) => {
    const quantity = item.quantity || 1;
    const retailPriceCents = dollarsToCents(item.price);
    const grossTotalCents = retailPriceCents * quantity;
    const rawDiscount = splitDiscountAllocations(item, discountApplications);
    return buildNormalizedLineItem(
      { item, quantity, retailPriceCents, grossTotalCents, rawDiscount },
      rawDiscount.planDiscountCents,
      rawDiscount.couponDiscountCents,
    );
  });
}
