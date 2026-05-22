import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import { sendProcurementHealthCriticalEscalation } from "./procurement-health-escalation.service";
import { loadProcurementHealthSummary } from "./procurement-health-summary.service";

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
