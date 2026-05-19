import type {
  AutoDraftRecommendationSettings,
  PurchasingRecommendationItem,
  PurchasingRecommendationResult,
} from "./purchasing-recommendation.engine";

export interface PurchasingRecommendationRunPoMutation {
  vendorId: number;
  poId: number;
  action: "created" | "updated" | "upserted";
  linesAdded: number;
}

export interface PurchasingRecommendationRunDetailOptions {
  lookbackDays: number;
  settings?: AutoDraftRecommendationSettings;
  generatedAt?: Date;
  poMutations?: PurchasingRecommendationRunPoMutation[];
}

export interface PurchasingRecommendationRunDetail {
  version: 1;
  generatedAt: string;
  lookbackDays: number;
  settings: AutoDraftRecommendationSettings;
  recommendationSummary: PurchasingRecommendationResult["summary"];
  statusCounts: Record<string, number>;
  skippedReasonCounts: Record<string, number>;
  actionableRecommendations: Array<ReturnType<typeof summarizeRecommendation>>;
  skippedRecommendations: Array<ReturnType<typeof summarizeRecommendation>>;
  poMutations: PurchasingRecommendationRunPoMutation[];
}

function increment(map: Record<string, number>, key: string | null | undefined) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function summarizeRecommendation(item: PurchasingRecommendationItem) {
  return {
    recommendationId: item.recommendationId,
    productId: item.productId,
    productVariantId: item.productVariantId ?? null,
    sku: item.sku,
    productName: item.productName,
    status: item.status,
    actionable: item.actionable,
    skippedReason: item.skippedReason,
    preferredVendorId: item.preferredVendorId,
    preferredVendorName: item.preferredVendorName,
    available: item.available,
    onOrderPieces: item.onOrderPieces,
    reorderPoint: item.reorderPoint,
    avgDailyUsage: item.avgDailyUsage,
    leadTimeDays: item.leadTimeDays,
    safetyStockDays: item.safetyStockDays,
    suggestedOrderQty: item.suggestedOrderQty,
    suggestedOrderPieces: item.suggestedOrderPieces,
    orderUomLabel: item.orderUomLabel,
    estimatedCostCents: item.estimatedCostCents,
    confidence: item.confidence,
    explanation: item.explanation,
    reviewSignal: item.reviewSignal,
  };
}

export function buildPurchasingRecommendationRunDetail(
  result: PurchasingRecommendationResult,
  options: PurchasingRecommendationRunDetailOptions,
): PurchasingRecommendationRunDetail {
  const statusCounts: Record<string, number> = {};
  const skippedReasonCounts: Record<string, number> = {};

  for (const item of result.items) {
    increment(statusCounts, item.status);
  }
  for (const item of result.skippedItems) {
    increment(skippedReasonCounts, item.skippedReason);
  }

  return {
    version: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    lookbackDays: options.lookbackDays,
    settings: options.settings ?? {},
    recommendationSummary: result.summary,
    statusCounts,
    skippedReasonCounts,
    actionableRecommendations: result.items
      .filter((item) => item.actionable)
      .slice(0, 25)
      .map(summarizeRecommendation),
    skippedRecommendations: result.skippedItems
      .slice(0, 25)
      .map(summarizeRecommendation),
    poMutations: options.poMutations ?? [],
  };
}
