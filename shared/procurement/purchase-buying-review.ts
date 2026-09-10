/** Human buying review is distinct from physical stock status and auto-draft eligibility. */
export interface PurchaseBuyingReviewItem {
  status: string;
  suggestedOrderPieces: number;
  onOrderPieces?: number;
  skippedReason?: string | null;
  supplyTiming?: { reviewRequired: boolean; signal?: string };
}

export type PurchaseBuyingDisposition =
  | "purchase_now"
  | "purchase_soon"
  | "supply_review"
  | "no_purchase_needed"
  | "excluded";

export function purchaseBuyingDisposition(item: PurchaseBuyingReviewItem): PurchaseBuyingDisposition {
  if (item.skippedReason === "excluded") return "excluded";
  // Unresolved receipts make both buy and no-buy conclusions unverified,
  // even if the numeric fallback currently suggests a positive quantity.
  if (item.supplyTiming?.signal === "unverified_receipts") return "supply_review";
  // A missing supplier/quote is work for the buyer, not a reason to hide demand.
  // Conversely, a stockout already covered by commitments is not a new order.
  const hasPurchaseQuantity = Number.isSafeInteger(item.suggestedOrderPieces)
    && item.suggestedOrderPieces > 0
    && item.skippedReason !== "already_on_order";
  if (hasPurchaseQuantity) {
    if (item.status === "stockout" || item.status === "order_now") return "purchase_now";
  }
  // Upcoming alerts reach the buyer before stock crosses the target, so they
  // normally have zero quantity today. Existing commitments go to arrival
  // review instead; this advisory does not add zero quantities to spend.
  if (item.status === "order_soon" && (hasPurchaseQuantity || (
    item.suggestedOrderPieces === 0 && !(typeof item.onOrderPieces === "number" && item.onOrderPieces > 0)
  ))) return "purchase_soon";
  return item.supplyTiming?.reviewRequired === true ? "supply_review" : "no_purchase_needed";
}

export interface PurchaseBuyingCounts {
  stockout: number;
  orderNow: number;
  orderSoon: number;
  supplyReview: number;
}

export function purchaseBuyingCounts(items: readonly PurchaseBuyingReviewItem[]): PurchaseBuyingCounts {
  const counts = { stockout: 0, orderNow: 0, orderSoon: 0, supplyReview: 0 };
  for (const item of items) {
    const disposition = purchaseBuyingDisposition(item);
    if (disposition === "purchase_now") {
      if (item.status === "stockout") counts.stockout++;
      else counts.orderNow++;
    } else if (disposition === "purchase_soon") counts.orderSoon++;
    else if (disposition === "supply_review") counts.supplyReview++;
  }
  return counts;
}

export interface PurchasePriorityItem extends PurchaseBuyingReviewItem {
  productId: number;
  sku: string;
  daysOfSupply: number;
  planningBasis?: { essential?: boolean };
}

/** Stable ordering shared by dashboard and queue, independent of catalog row order. */
export function comparePurchaseBuyingPriority(a: PurchasePriorityItem, b: PurchasePriorityItem): number {
  const rank = (item: PurchasePriorityItem): number => {
    const disposition = purchaseBuyingDisposition(item);
    if (disposition === "purchase_now") return item.status === "stockout" ? 0 : 1;
    if (disposition === "purchase_soon") return 2;
    if (disposition === "supply_review") return 3;
    return disposition === "excluded" ? 5 : 4;
  };
  return rank(a) - rank(b)
    || Number(b.planningBasis?.essential === true) - Number(a.planningBasis?.essential === true)
    || a.daysOfSupply - b.daysOfSupply
    || a.productId - b.productId
    || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
}
