import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipCostDetectionService } from "../../application/dropship-cost-detection-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipCostDetectionServiceFromEnv } from "../../infrastructure/dropship-cost-detection.factory";

/**
 * Admin read surface for what cost detection has found (migration 0711,
 * docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C2): the worker's state and the
 * announced changes, and the change log a page at a time. Read-only: the
 * schedule is written only by the detection worker.
 */
export function registerDropshipAdminCostChangeActivityRoutes(
  app: Express,
  service: DropshipCostDetectionService = createDropshipCostDetectionServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/cost-changes/detection",
    requirePermission("dropship", "view"),
    async (_req, res) => {
      try {
        return res.json(await service.getOverview());
      } catch (error) {
        return sendCostChangeActivityError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/admin/cost-changes/log",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        // Query strings arrive as text; the service's strict contract decides
        // whether the numbers are acceptable.
        return res.json(await service.listChangeLog({
          ...(req.query.limit !== undefined ? { limit: numberFromQuery(req.query.limit) } : {}),
          ...(req.query.beforeId !== undefined ? { beforeId: numberFromQuery(req.query.beforeId) } : {}),
        }));
      } catch (error) {
        return sendCostChangeActivityError(res, error);
      }
    },
  );
}

function numberFromQuery(value: Request["query"][string]): unknown {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
}

function sendCostChangeActivityError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForCostChangeActivityError(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error(JSON.stringify({
    level: "error",
    code: "DROPSHIP_COST_CHANGE_ACTIVITY_INTERNAL_ERROR",
    message: "Unexpected cost change activity request error.",
    context: { error: error instanceof Error ? error.message : String(error) },
  }));
  return res.status(500).json({
    error: { code: "DROPSHIP_COST_CHANGE_ACTIVITY_INTERNAL_ERROR", message: "Dropship cost change activity request failed." },
  });
}

export function statusForCostChangeActivityError(code: string): number {
  switch (code) {
    case "DROPSHIP_COST_DETECTION_INVALID_INPUT":
    case "DROPSHIP_COST_SCHEDULE_INVALID_INPUT":
      return 400;
    // The tables are not there yet: the caller retries after migration 0711 lands.
    case "DROPSHIP_COST_SCHEDULE_TABLE_MISSING":
    case "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING":
      return 503;
    default:
      return 500;
  }
}
