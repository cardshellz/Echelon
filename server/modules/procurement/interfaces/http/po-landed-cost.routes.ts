import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import { logger } from "../../../../platform/observability/logger";
import {
  createPoLandedCostService,
  PoLandedCostError,
} from "../../application/po-landed-cost.service";

const positiveIdParamSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));

function getActorId(req: Request): string {
  return String(req.session?.user?.id ?? "").trim();
}

function sendPoLandedCostError(res: Response, error: unknown, context: Record<string, unknown>) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      code: "PO_LANDED_COST_INPUT_INVALID",
      error: error.issues[0]?.message ?? "Invalid landed cost input.",
      details: error.issues,
    });
  }
  if (error instanceof PoLandedCostError) {
    return res.status(error.statusCode).json({
      code: error.code,
      error: error.message,
      details: error.details,
    });
  }
  logger.error("procurement.po_landed_cost.failed", {
    event: "procurement.po_landed_cost.failed",
    ...context,
    errorType: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return res.status(500).json({
    code: "PO_LANDED_COST_INTERNAL_ERROR",
    error: "Failed to process PO landed cost charge.",
  });
}

export function registerPoLandedCostRoutes(
  app: Express,
  service = createPoLandedCostService(db as any),
) {
  app.get(
    "/api/purchase-orders/:id/landed-costs",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const poId = positiveIdParamSchema.parse(req.params.id);
        const result = await service.getPoLandedCosts(poId);
        return res.json(result);
      } catch (error) {
        return sendPoLandedCostError(res, error, { poId: req.params.id, op: "get" });
      }
    },
  );

  app.post(
    "/api/purchase-orders/:id/landed-costs",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const poId = positiveIdParamSchema.parse(req.params.id);
        const actorId = getActorId(req);
        const result = await service.addPoLandedCost(poId, req.body, actorId);
        return res.status(201).json(result);
      } catch (error) {
        return sendPoLandedCostError(res, error, { poId: req.params.id, op: "create" });
      }
    },
  );

  app.patch(
    "/api/purchase-orders/:id/landed-costs/:chargeId",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const poId = positiveIdParamSchema.parse(req.params.id);
        const chargeId = positiveIdParamSchema.parse(req.params.chargeId);
        const actorId = getActorId(req);
        const result = await service.updatePoLandedCost(poId, chargeId, req.body, actorId);
        return res.json(result);
      } catch (error) {
        return sendPoLandedCostError(res, error, {
          poId: req.params.id,
          chargeId: req.params.chargeId,
          op: "update",
        });
      }
    },
  );

  app.delete(
    "/api/purchase-orders/:id/landed-costs/:chargeId",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const poId = positiveIdParamSchema.parse(req.params.id);
        const chargeId = positiveIdParamSchema.parse(req.params.chargeId);
        const actorId = getActorId(req);
        const result = await service.removePoLandedCost(poId, chargeId, actorId);
        return res.json(result);
      } catch (error) {
        return sendPoLandedCostError(res, error, {
          poId: req.params.id,
          chargeId: req.params.chargeId,
          op: "delete",
        });
      }
    },
  );
}
