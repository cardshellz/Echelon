import { db as defaultDb } from "../../db";
import { inventoryStorage } from "../inventory";
import { procurementStorage } from "../procurement";
import { buildStaleAutoDraftPoDiagnostics, type AutoDraftPoAgingThresholds } from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";
import { buildInFlightPoAgingDiagnostics } from "./in-flight-po-aging.service";
import { fetchInFlightPoAgingRows } from "./in-flight-po-aging.repository";
import { loadPurchaseRecommendationPipelineHealth } from "./purchase-recommendation-pipeline-health.service";
import { buildProcurementHealthSummary, type ProcurementHealthSummary } from "./procurement-health.service";
import { buildForecastTrustHealth } from "./forecast-trust-health.service";
import {
  generatePurchasingRecommendations,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";
import { loadPurchasingRecommendationContext } from "./purchasing-recommendation-context.service";
import { buildSupplierSetupGaps } from "./supplier-setup-gaps.service";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

type ProcurementHealthStorage = {
  getAutoDraftSettings: () => Promise<AutoDraftRecommendationSettings & {
    stalePoThresholds?: Partial<AutoDraftPoAgingThresholds>;
  }>;
  getVelocityLookbackDays: () => Promise<number>;
  getReorderAnalysisData: (lookbackDays: number) => Promise<unknown[]>;
};

type ShipmentTrackingHealthSource = {
  getLandedCostHealth: (input: { limit: number }) => Promise<{
    status: string;
    critical: number;
    warning: number;
  }>;
};

const defaultStorage = { ...procurementStorage, ...inventoryStorage } as ProcurementHealthStorage;

export async function loadProcurementHealthSummary(options: {
  shipmentTracking: ShipmentTrackingHealthSource;
  limit: number;
  db?: DbWithExecute;
  storage?: ProcurementHealthStorage;
  asOf?: Date;
}): Promise<ProcurementHealthSummary> {
  const db = options.db ?? defaultDb;
  const storage = options.storage ?? defaultStorage;
  const { shipmentTracking, limit } = options;
  const asOf = options.asOf ? new Date(options.asOf.getTime()) : new Date();
  const [
    landedCostHealth,
    autoDraftRows,
    inFlightPoRows,
    settings,
    configuredLookback,
    recommendationContext,
    recommendationPipelineHealth,
  ] = await Promise.all([
    shipmentTracking.getLandedCostHealth({ limit }),
    fetchAutoDraftPoAgingRows(db, { scanLimit: 500 }),
    fetchInFlightPoAgingRows(db, { scanLimit: 500 }),
    storage.getAutoDraftSettings(),
    storage.getVelocityLookbackDays(),
    loadPurchasingRecommendationContext(),
    loadPurchaseRecommendationPipelineHealth({ db, asOf }),
  ]);
  const rawRows = await storage.getReorderAnalysisData(configuredLookback);
  const recommendationResult = generatePurchasingRecommendations({
    rows: rawRows as PurchasingRecommendationRawRow[],
    lookbackDays: configuredLookback,
    autoDraftSettings: settings,
    requireVendor: Boolean(settings.skipNoVendor),
    ...recommendationContext,
  });
  const supplierSetupGaps = buildSupplierSetupGaps(recommendationResult);
  const forecastTrustHealth = buildForecastTrustHealth(recommendationResult);

  const staleAutoDraftPos = buildStaleAutoDraftPoDiagnostics(autoDraftRows, {
    limit,
    thresholds: settings.stalePoThresholds,
  });
  const inFlightPoAging = buildInFlightPoAgingDiagnostics(inFlightPoRows, {
    limit,
    thresholds: settings.stalePoThresholds,
  });

  return buildProcurementHealthSummary({
    staleAutoDraftPos,
    landedCostHealth,
    supplierSetupGaps,
    inFlightPoAging,
    forecastTrustHealth,
    recommendationPipelineHealth,
    generatedAt: asOf,
  });
}
