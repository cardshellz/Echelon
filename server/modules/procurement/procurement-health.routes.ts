import type { Express } from "express";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { inventoryStorage } from "../inventory";
import { procurementStorage } from "../procurement";
import { buildStaleAutoDraftPoDiagnostics } from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";
import { buildInFlightPoAgingDiagnostics } from "./in-flight-po-aging.service";
import { fetchInFlightPoAgingRows } from "./in-flight-po-aging.repository";
import { buildProcurementHealthSummary, type ProcurementHealthSummary } from "./procurement-health.service";
import { sendProcurementHealthCriticalEscalation } from "./procurement-health-escalation.service";
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

function parseDedupeHours(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 168);
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

async function loadProcurementHealthSummary(options: {
  shipmentTracking: { getLandedCostHealth: (input: { limit: number }) => Promise<any> };
  limit: number;
}): Promise<ProcurementHealthSummary> {
  const { shipmentTracking, limit } = options;
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

  return buildProcurementHealthSummary({
    staleAutoDraftPos,
    landedCostHealth,
    supplierSetupGaps,
    inFlightPoAging,
  });
}

export function registerProcurementHealthRoutes(app: Express) {
  app.get("/api/procurement/health", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const limit = parseHealthLimit(req.query.limit);
      const { shipmentTracking } = app.locals.services;
      res.json(await loadProcurementHealthSummary({ shipmentTracking, limit }));
    } catch (error: any) {
      console.error("Error fetching procurement health:", error);
      res.status(500).json({ error: "Failed to fetch procurement health" });
    }
  });

  app.post("/api/procurement/health/escalation", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const limit = parseHealthLimit(req.body?.limit ?? req.query.limit);
      const dedupeHours = parseDedupeHours(req.body?.dedupeHours ?? req.query.dedupeHours);
      const force = parseBoolean(req.body?.force ?? req.query.force);
      const { shipmentTracking } = app.locals.services;
      const health = await loadProcurementHealthSummary({ shipmentTracking, limit });
      const escalation = await sendProcurementHealthCriticalEscalation(health, { dedupeHours, force });
      res.json({ health, escalation });
    } catch (error: any) {
      console.error("Error escalating procurement health:", error);
      res.status(500).json({ error: "Failed to escalate procurement health" });
    }
  });
}
