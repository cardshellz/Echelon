import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { shipmentEditorScope, type createShipmentEditorService } from "./shipment-editor.service";
export function registerShipmentEditorRoutes(app: Express, service: ReturnType<typeof createShipmentEditorService>) {
  const root = shipmentEditorScope(1).routeTemplate;
  function identity(req: Request) {
    const actorId = req.session.user?.id;
    if (!actorId) throw new FinancialCommandError("Sign in to edit a shipment.", 401, "SHIPMENT_EDITOR_AUTH");
    return { actorId, id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentLineResourceIdSchema).parse(req.params.id) };
  }
  function fail(error: unknown, req: Request, res: Response) {
    const known = error instanceof FinancialCommandError || error instanceof ShipmentTrackingError;
    const code = error instanceof FinancialCommandError ? error.code : error instanceof ShipmentTrackingError ? error.details?.code : error instanceof z.ZodError ? "SHIPMENT_EDITOR_INPUT" : "SHIPMENT_EDITOR_UNAVAILABLE";
    logger.error("procurement.shipment_editor.failed", { shipment_id: req.params.id, actor_id: req.session.user?.id, code, error_class: error instanceof Error ? error.name : typeof error });
    if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
    res.status(known ? error.statusCode : error instanceof z.ZodError ? 400 : 503).json({ code, error: known ? error.message : error instanceof z.ZodError ? "Review the line quantities, amounts and reason." : "The edit could not be confirmed. Retry the same approval." });
  }
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { const { id, actorId } = identity(req); res.json(await service.context(id, actorId)); } catch (error) { fail(error, req, res); }
  });
  app.post(`${root}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { const { id, actorId } = identity(req); res.json(await service.preview(id, req.body, actorId)); } catch (error) { fail(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const { id, actorId } = identity(req);
      const result = await service.approve(id, req.body, actorId, financialCommandFromRequest(req, { actorId, ...shipmentEditorScope(id) }));
      const body = result.terminalState === "rejected" ? { ...(result.body as object), rejected: true } : result.body;
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.status(result.httpStatus).json(body);
    } catch (error) { fail(error, req, res); }
  });
}
