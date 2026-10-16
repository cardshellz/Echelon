import type { Express, Request, Response } from "express";
import { z } from "zod";
import { reconciliationRequestSchema } from "@shared/procurement/cost-reconciliation";
import { shipmentExceptionIdSchema } from "@shared/procurement/shipment-cost-exception";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { ShipmentCostExceptionError } from "./shipment-cost-exception.policy";
import {
  createShipmentCostReconciliationService,
  shipmentReconciliationScope,
} from "./shipment-cost-reconciliation.service";

const pathId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(shipmentExceptionIdSchema);
export function registerShipmentCostReconciliationRoutes(
  app: Express,
  service = createShipmentCostReconciliationService(db, () => new Date()),
) {
  const root = "/api/shipment-lines/:id/cost-reconciliation";
  const identity = (req: Request) => {
    const line = pathId.safeParse(req.params.id),
      actorId = req.session.user?.id;
    if (!actorId)
      throw new FinancialCommandError("Sign in to reconcile shipment costs.", 401, "SHIPMENT_RECONCILIATION_AUTH");
    if (!line.success)
      throw new FinancialCommandError("Choose a valid shipment line.", 400, "SHIPMENT_RECONCILIATION_ID");
    return { lineId: line.data, actorId };
  };
  const failure = (error: unknown, req: Request, res: Response) => {
    const known = error instanceof FinancialCommandError || error instanceof ShipmentCostExceptionError;
    logger.warn("procurement.shipment_cost_reconciliation", {
      line_id: req.params.id,
      actor_id: req.session.user?.id,
      outcome: known ? "rejected" : "failed",
      error_code: known ? error.code : "SHIPMENT_RECONCILIATION_FAILED",
    });
    if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
    return res
      .status(known ? error.statusCode : 500)
      .json({
        code: known ? error.code : "SHIPMENT_RECONCILIATION_FAILED",
        error: known
          ? error.message
          : "Reconciliation could not be confirmed. Reload the saved result or retry the same approval.",
      });
  };
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { lineId, actorId } = identity(req);
      res.json(await service.context(lineId, actorId));
    } catch (error) {
      failure(error, req, res);
    }
  });
  app.get("/api/cogs/historical-adjustments", requirePermission("inventory", "view"), async (req, res) => {
    try {
      res.json(await service.report());
    } catch (error) {
      failure(error, req, res);
    }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const { lineId, actorId } = identity(req),
        input = reconciliationRequestSchema.safeParse(req.body);
      if (!input.success)
        throw new FinancialCommandError(
          "Choose a cost destination and enter a reason of at least 10 characters.",
          400,
          "SHIPMENT_RECONCILIATION_INPUT",
        );
      const descriptor = financialCommandFromRequest(req, { actorId, ...shipmentReconciliationScope(lineId) });
      const result = await service.reconcile(lineId, input.data, actorId, descriptor);
      logger.info("procurement.shipment_cost_reconciliation", {
        line_id: lineId,
        actor_id: actorId,
        command_key: descriptor.idempotencyKey,
        http_status: result.httpStatus,
        replayed: result.replayed,
        destination: input.data.destination,
      });
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      failure(error, req, res);
    }
  });
}
