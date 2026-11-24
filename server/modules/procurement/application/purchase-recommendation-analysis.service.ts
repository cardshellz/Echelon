import {
  generatePurchasingRecommendations,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";
import { loadPurchasingRecommendationContext } from "./purchasing-recommendation-context.service";

export interface PurchaseRecommendationAnalysisStorage<TSettings extends AutoDraftRecommendationSettings> {
  getVelocityLookbackDays(): Promise<number>;
  getReorderAnalysisData(lookbackDays: number): Promise<unknown[]>;
  getAutoDraftSettings(): Promise<TSettings>;
}

export async function loadPurchaseRecommendationSnapshotAnalysis<
  TSettings extends AutoDraftRecommendationSettings,
>(input: {
  storage: PurchaseRecommendationAnalysisStorage<TSettings>;
  contextLoader?: typeof loadPurchasingRecommendationContext;
}) {
  const contextLoader = input.contextLoader ?? loadPurchasingRecommendationContext;
  const [lookbackDays, settings] = await Promise.all([
    input.storage.getVelocityLookbackDays(),
    input.storage.getAutoDraftSettings(),
  ]);
  const [rawRows, context] = await Promise.all([
    input.storage.getReorderAnalysisData(lookbackDays),
    contextLoader(),
  ]);
  const recommendationResult = generatePurchasingRecommendations({
    rows: rawRows as PurchasingRecommendationRawRow[],
    lookbackDays,
    autoDraftSettings: settings,
    requireVendor: Boolean(settings.skipNoVendor),
    ...context,
  });

  return {
    settings,
    lookbackDays,
    rawRows,
    evaluatedCount: rawRows.length,
    recommendationResult,
  };
}
