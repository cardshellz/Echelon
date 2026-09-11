import type { Express, Response } from "express";
import { z } from "zod";
import { openingCaptureIdSchema, openingCaptureRequestSchema, openingCaptureChunkSchema,
  openingCaptureStatusSchema } from "@shared/types/inventory-opening-capture";
import { requirePermission } from "../../../../routes/middleware";
import type { InventoryOpeningCapturePort } from "../../application/inventory-opening-capture.port";
import { InventoryCutoverOpeningError } from "../../application/inventory-cutover-opening.service";

const ROOT = "/api/inventory-planning/admin/cutover-opening/captures";
const actorSchema = z.string().trim().min(1).max(100);
const noQuery = z.object({}).strict();
function sendError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).json({ error: { code: "CUTOVER_CAPTURE_REQUEST_INVALID", message: "Invalid capture request." } });
  if (error instanceof InventoryCutoverOpeningError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  console.error(JSON.stringify({ event: "inventory_opening_capture_http_failed", code: "CUTOVER_CAPTURE_REQUEST_FAILED" }));
  return res.status(503).json({ error: { code: "CUTOVER_CAPTURE_REQUEST_FAILED", message: "The capture service is unavailable. Retry the same request." } });
}

export function registerInventoryOpeningCaptureRoutes(app: Express, jobs: InventoryOpeningCapturePort): void {
  const permission = requirePermission("inventory_planning", "activate");
  app.use(ROOT, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.post(ROOT, permission, async (req, res) => {
    try {
      noQuery.parse(req.query);
      const request = openingCaptureRequestSchema.parse(req.body);
      const result = await jobs.enqueue(actorSchema.parse(req.session?.user?.id), request.idempotencyKey);
      return res.status(202).json(openingCaptureStatusSchema.parse(result));
    } catch (error) { return sendError(res,error); }
  });
  app.get(ROOT + "/:id", permission, async (req, res) => {
    try {
      noQuery.parse(req.query);
      return res.json(openingCaptureStatusSchema.parse(await jobs.status(actorSchema.parse(req.session?.user?.id), openingCaptureIdSchema.parse(req.params.id))));
    } catch (error) { return sendError(res,error); }
  });
  app.get(ROOT + "/:id/chunks/:index", permission, async (req, res) => {
    try {
      noQuery.parse(req.query);
      const indexText = z.string().regex(/^(0|[1-9][0-9]{0,3})$/).parse(req.params.index);
      const index = openingCaptureChunkSchema.shape.index.parse(Number(indexText));
      return res.json(openingCaptureChunkSchema.parse(await jobs.chunk(actorSchema.parse(req.session?.user?.id), openingCaptureIdSchema.parse(req.params.id), index)));
    } catch (error) { return sendError(res,error); }
  });
}
