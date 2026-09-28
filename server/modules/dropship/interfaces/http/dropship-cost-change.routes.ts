import type { Express, Response } from "express";
import type { DropshipCostChangeNoticeService } from "../../application/dropship-cost-change-notice-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipCostChangeNoticeServiceFromEnv } from "../../infrastructure/dropship-cost-change-notice.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

/**
 * The vendor's own view of .ops cost changes on their listings
 * (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C4): what is announced and not yet
 * in effect, what changed recently, and the policy's notice terms. Read-only.
 */
export function registerDropshipCostChangeRoutes(
  app: Express,
  service: DropshipCostChangeNoticeService = createDropshipCostChangeNoticeServiceFromEnv(),
): void {
  app.get("/api/dropship/cost-changes", requireDropshipAuth, async (req, res) => {
    try {
      return res.json(await service.getVendorViewForMember(req.session.dropship!.memberId));
    } catch (error) {
      return sendCostChangeError(res, error);
    }
  });
}

function sendCostChangeError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForVendorCostChangeError(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error(JSON.stringify({
    level: "error",
    code: "DROPSHIP_COST_CHANGE_INTERNAL_ERROR",
    message: "Unexpected vendor cost change request error.",
    context: { error: error instanceof Error ? error.message : String(error) },
  }));
  return res.status(500).json({ error: { code: "DROPSHIP_COST_CHANGE_INTERNAL_ERROR", message: "Dropship cost change request failed." } });
}

export function statusForVendorCostChangeError(code: string): number {
  switch (code) {
    case "DROPSHIP_COST_CHANGE_INVALID_INPUT":
      return 400;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_ENTITLEMENT_INACTIVE":
      return 403;
    case "DROPSHIP_COST_SCHEDULE_TABLE_MISSING":
    case "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING":
      return 503;
    default:
      return 500;
  }
}
