/**
 * Shopify Line Item Normalization
 * 
 * Extracts line item data from Shopify webhooks with full discount splitting logic.
 * This matches the logic from shellz-club-app/server/routes/helpers.ts::normalizeShopifyLineItem
 * to ensure plan_discount_cents and coupon_discount_cents are calculated correctly.
 */

// Rewards redemption detection constants
const REWARDS_REDEMPTION_LABEL = process.env.REWARDS_REDEMPTION_LABEL || "Shellz Rewards Redemption";

export interface NormalizedLineItem {
  externalLineItemId: string;
  externalProductId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  name: string | null;
  vendor: string | null;
  quantity: number;
  paidPriceCents: number;
  totalCents: number;
  discountCents: number;
  planDiscountCents: number;
  couponDiscountCents: number;
}

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

/**
 * Normalizes a Shopify line item with full discount splitting logic.
 * 
 * Discount splitting rules:
 * - "manual" discounts → plan_discount_cents (member wholesale pricing)
 * - EXCEPT manual discounts with SHELLZ-* codes → coupon_discount_cents (rewards redemptions)
 * - All other discount types → coupon_discount_cents (discount codes, automatic, script)
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
  const quantity = item.quantity || 1;
  const retailPriceCents = Math.round(parseFloat(item.price || "0") * 100);

  const discountAllocations = item.discount_allocations || [];
  let planDiscountCents = 0;
  let couponDiscountCents = 0;

  // Split discounts into plan vs coupon based on type + rewards detection
  for (const alloc of discountAllocations) {
    const allocAmount = Math.round(parseFloat(alloc.amount || "0") * 100);
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

  const totalDiscountCents = planDiscountCents + couponDiscountCents;

  // Calculate prices
  const paidPriceCents = Math.round(retailPriceCents - totalDiscountCents / quantity);
  const totalCents = retailPriceCents * quantity - totalDiscountCents;

  return {
    externalLineItemId: item.id?.toString() || "",
    externalProductId: item.product_id?.toString() || null,
    sku: item.sku || null,
    title: `${item.title}${item.variant_title ? ` - ${item.variant_title}` : ""}`,
    variantTitle: item.variant_title || null,
    name: item.name || null,
    vendor: item.vendor || null,
    quantity,
    paidPriceCents,
    totalCents,
    discountCents: totalDiscountCents,
    planDiscountCents,
    couponDiscountCents,
  };
}

/**
 * Batch normalizes all line items from a Shopify order
 */
export function normalizeShopifyLineItems(
  lineItems: any[],
  discountApplications: any[],
  orderNumber?: string
): NormalizedLineItem[] {
  return lineItems.map((item) => normalizeShopifyLineItem(item, discountApplications, orderNumber));
}
