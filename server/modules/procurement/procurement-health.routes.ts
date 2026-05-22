import type { Express } from "express";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { procurementStorage } from "../procurement";
import { buildStaleAutoDraftPoDiagnostics } from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";
import { buildProcurementHealthSummary } from "./procurement-health.service";

const storage = procurementStorage;

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
      const [landedCostHealth, autoDraftRows, settings] = await Promise.all([
        shipmentTracking.getLandedCostHealth({ limit }),
        fetchAutoDraftPoAgingRows(db, { scanLimit: 500 }),
        storage.getAutoDraftSettings(),
      ]);

      const staleAutoDraftPos = buildStaleAutoDraftPoDiagnostics(autoDraftRows, {
        limit,
        thresholds: settings.stalePoThresholds,
      });

      res.json(buildProcurementHealthSummary({
        staleAutoDraftPos,
        landedCostHealth,
      }));
    } catch (error: any) {
      console.error("Error fetching procurement health:", error);
      res.status(500).json({ error: "Failed to fetch procurement health" });
    }
  });
}
