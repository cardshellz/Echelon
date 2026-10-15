import type { Express, Request, Response } from "express";
import { z } from "zod";
import { shipmentExceptionIdSchema, shipmentExceptionRequestSchema } from "@shared/procurement/shipment-cost-exception";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { createShipmentCostExceptionService, shipmentExceptionScope } from "./shipment-cost-exception.service";
import { ShipmentCostExceptionError } from "./shipment-cost-exception.policy";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentExceptionIdSchema);
export function registerShipmentCostExceptionRoutes(app: Express, service = createShipmentCostExceptionService(db, () => new Date())) {
  const root = "/api/shipment-lines/:id/cost-exception";
  function failure(error: unknown, req: Request, res: Response) {
    const known = error instanceof FinancialCommandError || error instanceof ShipmentCostExceptionError;
    logger.warn("procurement.shipment_cost_exception", { line_id: req.params.id, actor_id: req.session.user?.id,
      outcome: known ? "rejected" : "failed", error_code: known ? error.code : "SHIPMENT_EXCEPTION_FAILED" });
    if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
    return res.status(known ? error.statusCode : 500).json({
      error: known ? error.message : "The inventory exception review is unavailable. Reload it or retry your saved approval.",
      code: known ? error.code : "SHIPMENT_EXCEPTION_FAILED",
    });
  }
  function id(req: Request): number {
    const parsed = pathId.safeParse(req.params.id);
    if (!parsed.success) throw new FinancialCommandError("Choose a valid shipment line.", 400, "SHIPMENT_EXCEPTION_ID_INVALID");
    return parsed.data;
  }
  function actor(req: Request): string {
    const actorId = req.session.user?.id;
    if (!actorId) throw new FinancialCommandError("Sign in to review this exception.", 401, "SHIPMENT_EXCEPTION_ACTOR_REQUIRED");
    return actorId;
  }
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.context(id(req), actor(req))); } catch (error) { failure(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const lineId = id(req), actorId = actor(req);
      const input = shipmentExceptionRequestSchema.safeParse(req.body);
      if (!input.success) throw new FinancialCommandError("Review the decision and enter a reason of at least 10 characters.", 400, "SHIPMENT_EXCEPTION_INPUT_INVALID");
      const descriptor = financialCommandFromRequest(req, { actorId, ...shipmentExceptionScope(lineId) });
      const result = await service.decide(lineId, input.data, actorId, descriptor);
      logger.info("procurement.shipment_cost_exception", { line_id: lineId, actor_id: actorId,
        decision_action: input.data.action, http_status: result.httpStatus, replayed: result.replayed, command_key: descriptor.idempotencyKey });
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
