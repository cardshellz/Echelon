import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  products as productsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
} from "@shared/schema";
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
  confidence: PurchasingRecommendationItem["confidence"];
  rfqConfidence: PurchasingRecommendationItem["rfqConfidence"];
  recommendationCandidateScore: PurchasingRecommendationItem["recommendationCandidateScore"];
  forecastTrust: PurchasingRecommendationItem["demandBasis"]["forecastTrust"];
  qualityGate: PurchasingRecommendationItem["qualityGate"];
  autopilotBlockers: PurchasingRecommendationItem["autopilotBlockers"];
  supplierBasis: PurchasingRecommendationItem["supplierBasis"];
  demandSnapshot: Record<string, unknown>;
};

export function purchasingSkuAllocationKey(input: {
  productId: number;
  productVariantId?: number | null;
  warehouseId?: number | null;
}): string {
  return `${input.productId}:${input.productVariantId ?? "base"}:${input.warehouseId ?? "all"}`;
}

export async function lockAndLoadActiveRfqAllocations(
  tx: any,
  recommendations: Array<{ productId: number; productVariantId?: number | null; warehouseId?: number | null }>,
): Promise<Map<string, number>> {
  const productIds = Array.from(new Set<number>(recommendations.map((line) => Number(line.productId))))
    .sort((left, right) => left - right);
  if (productIds.length === 0) return new Map();

  await tx.select({ id: productsTable.id }).from(productsTable)
    .where(inArray(productsTable.id, productIds))
    .orderBy(productsTable.id)
    .for("update");

  const allocatedRecommendation = alias(purchaseRecommendationLinesTable, "allocated_recommendation");
  const allocations = await tx.select({
    productId: allocatedRecommendation.productId,
    productVariantId: allocatedRecommendation.productVariantId,
    warehouseId: allocatedRecommendation.warehouseId,
    requestedPieces: requestForQuoteLinesTable.requestedPieces,
  }).from(requestForQuoteLinesTable).innerJoin(
    allocatedRecommendation,
    eq(requestForQuoteLinesTable.recommendationLineId, allocatedRecommendation.id),
  ).where(and(
    inArray(allocatedRecommendation.productId, productIds),
    inArray(requestForQuoteLinesTable.status, ["draft", "sent", "quoted", "accepted", "ordered"]),
  ));

  const allocatedBySku = new Map<string, number>();
  for (const allocation of allocations) {
    const key = purchasingSkuAllocationKey(allocation);
    allocatedBySku.set(key, (allocatedBySku.get(key) ?? 0) + Number(allocation.requestedPieces));
  }
  return allocatedBySku;
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
      confidence: item.confidence,
      rfqConfidence: item.rfqConfidence,
      recommendationCandidateScore: item.recommendationCandidateScore,
      forecastTrust: item.demandBasis.forecastTrust,
      qualityGate: item.qualityGate,
      autopilotBlockers: item.autopilotBlockers,
      supplierBasis: item.supplierBasis,
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
