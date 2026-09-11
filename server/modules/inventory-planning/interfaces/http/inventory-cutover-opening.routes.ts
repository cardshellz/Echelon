import type { Express, RequestHandler, Response } from "express";
import { openingAssessmentSchema, openingSavedSchema, openingSourceSchema,
  openingVerificationSchema, saveOpeningRequestSchema } from "@shared/types/inventory-cutover-opening";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverOpeningError, InventoryCutoverOpeningService } from "../../application/inventory-cutover-opening.service";
import { PostgresInventoryCutoverOpeningRepository } from "../../infrastructure/inventory-cutover-opening.repository";
import { sendInventoryCutoverError } from "./inventory-cutover-commit.routes";
import { parseInventoryCutoverOpeningJson } from "./inventory-cutover-opening-body.middleware";
import { registerInventoryOpeningCaptureRoutes } from "./inventory-opening-capture.routes";
import { PostgresInventoryOpeningCaptureRepository } from "../../infrastructure/inventory-opening-capture.repository";
import { pool } from "../../../../db";

const ROOT = "/api/inventory-planning/admin/cutover-opening";
const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };

export function registerInventoryCutoverOpeningRoutes(app: Express,
  service: Pick<InventoryCutoverOpeningService, "capture" | "preview" | "save"> =
    new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository()),
): void {
  registerInventoryOpeningCaptureRoutes(app, new PostgresInventoryOpeningCaptureRepository(pool));
  app.get(ROOT + "/source", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      if (Object.keys(req.query).length > 0) throw invalid("Source capture does not accept query filters.");
      return res.json(openingSourceSchema.parse(await service.capture(req.session?.user?.id)));
    } catch (error) { return sendOpeningError(res, error); }
  });
  app.post(ROOT + "/preview", noStore, requirePermission("inventory_planning", "activate"), parseInventoryCutoverOpeningJson, async (req, res) => {
    try {
      const parsed = openingVerificationSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(req.query).length > 0) throw invalid("A complete opening verification is required; actor overrides and query filters are not accepted.");
      return res.json(openingAssessmentSchema.parse(await service.preview(parsed.data, req.session?.user?.id)));
    } catch (error) { return sendOpeningError(res, error); }
  });
  app.post(ROOT + "/verify", noStore, requirePermission("inventory_planning", "activate"), parseInventoryCutoverOpeningJson, async (req, res) => {
    try {
      const parsed = saveOpeningRequestSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(req.query).length > 0) throw invalid("A complete reviewed opening verification, reason and retry key are required.");
      const result = openingSavedSchema.parse(await service.save(parsed.data, req.session?.user?.id));
      return res.status(result.alreadyApplied ? 200 : 201).json(result);
    } catch (error) { return sendOpeningError(res, error); }
  });
}

function invalid(message: string) { return new InventoryCutoverOpeningError("CUTOVER_OPENING_REQUEST_INVALID", message, 400); }
function sendOpeningError(res: Response, error: unknown): Response {
  if (error instanceof InventoryCutoverOpeningError && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  return sendInventoryCutoverError(res, error);
}
