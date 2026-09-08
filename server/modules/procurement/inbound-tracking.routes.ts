import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { InboundTrackingError } from "./inbound-tracking.domain";
import { getInboundTrackingService } from "./inbound-tracking.runtime";
const routeId = (value: string): number => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)).parse(value);
const actor = (request: Request): unknown => (request as Request & { user?: { id?: unknown } }).user?.id ?? request.session?.user?.id;
function failure(error: unknown, response: Response): void {
  if (error instanceof InboundTrackingError) { response.status(error.status).json({ code: error.code, error: error.message }); return; }
  if (error instanceof z.ZodError) { response.status(400).json({ code: "TRACKING_INPUT_INVALID", error: "Tracking input is invalid. Check reference, carrier, revision and request key." }); return; }
  console.error(JSON.stringify({ event: "procurement.inbound_tracking.request_failed", code: "TRACKING_REQUEST_FAILED" }));
  response.status(500).json({ code: "TRACKING_REQUEST_FAILED", error: "Tracking request failed. Retry the same request key for any pending change." });
}
export function registerInboundTrackingRoutes(app: Express, service = getInboundTrackingService()): void {
  app.get("/api/inbound-shipments/:id/tracking", requirePermission("purchasing", "view"), async (request, response) => {
    try { response.json(await service.read(routeId(request.params.id))); } catch (error) { failure(error, response); }
  });
  app.get("/api/inbound-shipments/:id/tracking/:referenceId/history", requirePermission("purchasing", "view"), async (request, response) => {
    try { response.json(await service.history(routeId(request.params.id), routeId(request.params.referenceId), request.query.beforeId)); } catch (error) { failure(error, response); }
  });
  app.put("/api/inbound-shipments/:id/tracking", requirePermission("purchasing", "edit"), async (request, response) => {
    try { response.json(await service.save(routeId(request.params.id), request.body, actor(request))); } catch (error) { failure(error, response); }
  });
  app.post("/api/inbound-shipments/:id/tracking/:referenceId/refresh", requirePermission("purchasing", "edit"), async (request, response) => {
    try { response.status(202).json(await service.refresh(routeId(request.params.id), routeId(request.params.referenceId), request.body, actor(request))); } catch (error) { failure(error, response); }
  });
}
