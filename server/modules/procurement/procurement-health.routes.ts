import type { Express } from "express";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { inventoryStorage } from "../inventory";
import { procurementStorage } from "../procurement";
import { buildStaleAutoDraftPoDiagnostics } from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";
import { buildInFlightPoAgingDiagnostics } from "./in-flight-po-aging.service";
import { fetchInFlightPoAgingRows } from "./in-flight-po-aging.repository";
import { buildProcurementHealthSummary } from "./procurement-health.service";
import {
  generatePurchasingRecommendations,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";
import { loadPurchasingRecommendationContext } from "./purchasing-recommendation-context.service";
import { buildSupplierSetupGaps } from "./supplier-setup-gaps.service";

const storage = { ...procurementStorage, ...inventoryStorage };

function parseHealthLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 100);
}

export function registerProcurementHealthRoutes(app: Express) {
  app.get("/api/procurement/health", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const limit = parseHealthLimit(req.query.limit);
      const { shipmentTracking } = app.locals.services;
      const [landedCostHealth, autoDraftRows, inFlightPoRows, settings, configuredLookback, recommendationContext] = await Promise.all([
        shipmentTracking.getLandedCostHealth({ limit }),
        fetchAutoDraftPoAgingRows(db, { scanLimit: 500 }),
        fetchInFlightPoAgingRows(db, { scanLimit: 500 }),
        storage.getAutoDraftSettings(),
        storage.getVelocityLookbackDays(),
        loadPurchasingRecommendationContext(),
      ]);
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        autoDraftSettings: settings as AutoDraftRecommendationSettings,
        requireVendor: Boolean(settings.skipNoVendor),
        ...recommendationContext,
      });
      const supplierSetupGaps = buildSupplierSetupGaps(recommendationResult);

      const staleAutoDraftPos = buildStaleAutoDraftPoDiagnostics(autoDraftRows, {
        limit,
        thresholds: settings.stalePoThresholds,
      });
      const inFlightPoAging = buildInFlightPoAgingDiagnostics(inFlightPoRows, {
        limit,
        thresholds: settings.stalePoThresholds,
      });

      res.json(buildProcurementHealthSummary({
        staleAutoDraftPos,
        landedCostHealth,
        supplierSetupGaps,
        inFlightPoAging,
      }));
    } catch (error: any) {
      console.error("Error fetching procurement health:", error);
      res.status(500).json({ error: "Failed to fetch procurement health" });
    }
  });
}
