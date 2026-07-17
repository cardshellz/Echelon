import type { PurchasingRecommendationItem } from "./purchasing-recommendation.engine";

const nonRfqSkipReasons = new Set([
  "excluded",
  "already_on_order",
  "not_actionable_status",
  "zero_suggested_quantity",
]);

export type PurchasingRfqQueueItem = {
  recommendationId: string;
  productId: number;
  productVariantId: number | null;
  sku: string;
  productName: string;
  requestedPieces: number;
  availablePieces: number;
  onOrderPieces: number;
  reorderPointPieces: number;
  forecastMethod: string;
  forecastDailyPieces: number;
  leadTimeDays: number;
  safetyStockDays: number;
  forwardDemandPieces: number;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  vendorProductId: number | null;
  supplierAssignmentRequired: boolean;
  demandSnapshot: Record<string, unknown>;
};

export function purchasingSkuAllocationKey(input: {
  productId: number;
  productVariantId?: number | null;
  warehouseId?: number | null;
}): string {
  return `${input.productId}:${input.productVariantId ?? "base"}:${input.warehouseId ?? "all"}`;
}

export function isPurchasingRfqCandidate(item: PurchasingRecommendationItem): boolean {
  if (!Number.isSafeInteger(item.suggestedOrderPieces) || item.suggestedOrderPieces <= 0) return false;
  if (item.skippedReason && nonRfqSkipReasons.has(item.skippedReason)) return false;
  return item.status === "stockout" || item.status === "order_now" || item.status === "order_soon";
}

export function buildPurchasingRfqQueue(
  result: { items: PurchasingRecommendationItem[]; skippedItems: PurchasingRecommendationItem[] },
): PurchasingRfqQueueItem[] {
  const byRecommendation = new Map<string, PurchasingRecommendationItem>();
  for (const item of [...result.items, ...result.skippedItems]) {
    if (isPurchasingRfqCandidate(item)) byRecommendation.set(item.recommendationId, item);
  }

  return Array.from(byRecommendation.values())
    .map((item) => ({
      recommendationId: item.recommendationId,
      productId: item.productId,
      productVariantId: item.productVariantId ?? null,
      sku: item.sku,
      productName: item.productName,
      requestedPieces: item.suggestedOrderPieces,
      availablePieces: item.available,
      onOrderPieces: item.onOrderPieces,
      reorderPointPieces: item.reorderPoint,
      forecastMethod: item.forecastProvenance.forecastMethod,
      forecastDailyPieces: item.avgDailyUsage,
      leadTimeDays: item.leadTimeDays,
      safetyStockDays: item.safetyStockDays,
      forwardDemandPieces: item.forwardDemandBasis?.forwardDemandPieces ?? 0,
      preferredVendorId: item.preferredVendorId,
      preferredVendorName: item.preferredVendorName,
      vendorProductId: item.supplierBasis.vendorProductId,
      supplierAssignmentRequired: !item.preferredVendorId,
      demandSnapshot: {
        recommendationId: item.recommendationId,
        generatedForLookbackDays: item.forecastProvenance.demandWindowDays,
        status: item.status,
        availablePieces: item.available,
        onOrderPieces: item.onOrderPieces,
        effectiveSupplyPieces: item.currentSupply.effectiveSupplyPieces,
        reorderPointPieces: item.reorderPoint,
        suggestedOrderPieces: item.suggestedOrderPieces,
        demandBasis: item.demandBasis,
        forecastProvenance: item.forecastProvenance,
      },
    }))
    .sort((left, right) => {
      const leftUrgency = left.availablePieces <= 0 ? 0 : 1;
      const rightUrgency = right.availablePieces <= 0 ? 0 : 1;
      return leftUrgency - rightUrgency
        || right.requestedPieces - left.requestedPieces
        || left.sku.localeCompare(right.sku);
    });
}
