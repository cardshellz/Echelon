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
  discountIneligible: boolean;
}

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

function isDonationLine(item: any): boolean {
  const sku = String(item.sku || "").toUpperCase();
  const text = `${item.title || ""} ${item.name || ""} ${item.vendor || ""}`.toLowerCase();

  // Shopify creates synthetic SHOPIFY-* SKUs for some custom-sale lines. Only treat
  // them as donation lines when the human-visible text also says donation.
  return sku.startsWith("SHOPIFY-") && text.includes("donation");
}

function isDiscountIneligibleLine(item: any): boolean {
  // Club/rewards discounts are a Shopify workaround until we can return to real
  // line-item pricing. They can be commercial truth for products and memberships,
  // but they should never reduce donations or gift cards. If Shopify allocates a
  // discount there anyway, keep these lines at gross price and move that discount
  // onto eligible lines so OMS/WMS/ShipStation totals still reconcile.
  return item.gift_card === true || isDonationLine(item);
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

function allocateCentsByGross(totalCents: number, lines: PreparedLineItem[]): Map<PreparedLineItem, number> {
  const allocations = new Map<PreparedLineItem, number>();
  if (totalCents <= 0 || lines.length === 0) return allocations;

  const grossTotal = lines.reduce((sum, line) => sum + Math.max(0, line.grossTotalCents), 0);
  if (grossTotal <= 0) return allocations;

  let assigned = 0;
  const ranked = lines.map((line) => {
    const exact = (totalCents * line.grossTotalCents) / grossTotal;
    const whole = Math.floor(exact);
    assigned += whole;
    allocations.set(line, whole);
    return { line, remainder: exact - whole };
  });

  ranked.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < totalCents - assigned; i += 1) {
    const line = ranked[i % ranked.length].line;
    allocations.set(line, (allocations.get(line) || 0) + 1);
  }

  return allocations;
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
  const prepared = lineItems.map((item) => {
    const quantity = item.quantity || 1;
    const retailPriceCents = dollarsToCents(item.price);
    const grossTotalCents = retailPriceCents * quantity;
    const rawDiscount = splitDiscountAllocations(item, discountApplications);
    const discountIneligible = isDiscountIneligibleLine(item);
    return { item, quantity, retailPriceCents, grossTotalCents, rawDiscount, discountIneligible };
  });

  const eligible = prepared.filter((line) => !line.discountIneligible);
  const ineligibleDiscount = prepared
    .filter((line) => line.discountIneligible)
    .reduce(
      (sum, line) => ({
        planDiscountCents: sum.planDiscountCents + line.rawDiscount.planDiscountCents,
        couponDiscountCents: sum.couponDiscountCents + line.rawDiscount.couponDiscountCents,
      }),
      { planDiscountCents: 0, couponDiscountCents: 0 },
    );

  const extraPlanByLine = allocateCentsByGross(ineligibleDiscount.planDiscountCents, eligible);
  const extraCouponByLine = allocateCentsByGross(ineligibleDiscount.couponDiscountCents, eligible);

  return prepared.map((line) => {
    if (line.discountIneligible) {
      return buildNormalizedLineItem(line, 0, 0);
    }

    return buildNormalizedLineItem(
      line,
      line.rawDiscount.planDiscountCents + (extraPlanByLine.get(line) || 0),
      line.rawDiscount.couponDiscountCents + (extraCouponByLine.get(line) || 0),
    );
  });
}
