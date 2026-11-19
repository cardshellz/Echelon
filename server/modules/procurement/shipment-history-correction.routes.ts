import type { Express, Request, Response } from "express";
import { z } from "zod";
import { shipmentHistoryId, shipmentHistoryInputSchema, shipmentHistoryApprovalSchema } from "@shared/procurement/shipment-history-correction";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { ShipmentHistoryCorrectionError } from "./domain/shipment-history-correction";
import { shipmentHistoryScope, type createShipmentHistoryCorrectionService } from "./shipment-history-correction.service";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentHistoryId);
export function registerShipmentHistoryCorrectionRoutes(app: Express, service: ReturnType<typeof createShipmentHistoryCorrectionService>) {
  const root = shipmentHistoryScope(1).routeTemplate;
  function identity(req: Request) {
    if (!req.session.user?.id) throw new FinancialCommandError("Sign in to review shipment history.", 401, "SHIPMENT_HISTORY_AUTH");
    return { id: pathId.parse(req.params.id), actorId: req.session.user.id };
  }
  function failure(error: unknown, req: Request, res: Response) {
    const known = error instanceof FinancialCommandError || error instanceof ShipmentHistoryCorrectionError;
    const invalid = error instanceof z.ZodError;
    const code = known ? error.code : invalid ? "SHIPMENT_HISTORY_INPUT" : "SHIPMENT_HISTORY_UNAVAILABLE";
    logger.error("procurement.shipment_history.failed", { shipment_id: req.params.id, actor_id: req.session.user?.id, code, error_class: error instanceof Error ? error.name : typeof error });
    if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
    res.status(known ? error.statusCode : invalid ? 400 : 500).json({ code,
      error: known ? error.message : invalid ? "Enter valid document dates, a reason and confirmation of the manifest." : "Shipment history could not be verified. Retry the same request." });
  }
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { const { id, actorId } = identity(req); res.json(await service.context(id, actorId)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${root}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { const { id, actorId } = identity(req); res.json(await service.preview(id, shipmentHistoryInputSchema.parse(req.body), actorId)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const { id, actorId } = identity(req);
      const input = shipmentHistoryApprovalSchema.parse(req.body);
      const descriptor = financialCommandFromRequest(req, { actorId, ...shipmentHistoryScope(id) });
      const result = await service.approve(id, input, actorId, descriptor);
      logger.info("procurement.shipment_history.approval", { shipment_id: id, actor_id: actorId, command_key: descriptor.idempotencyKey, replayed: result.replayed, http_status: result.httpStatus });
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
