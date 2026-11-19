import type { Express, Response } from "express";
import { ZodError } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryProductSyncError, InventoryProductSyncService } from "../../application/inventory-product-sync.service";
import { PostgresInventoryProductSyncStore } from "../../infrastructure/inventory-product-sync.repository";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";
import { logger } from "../../../../platform/observability/logger";
import type { ProductSyncWorkflowService } from "../../application/product-sync-workflow.service";

const root = "/api/inventory-planning/admin/product-sync";
export function registerProductSyncWorkflowRoutes(app: Express, service: Pick<ProductSyncWorkflowService, "start" | "progress">): void {
  app.post(root + "/requests", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.status(202).json(await service.start(req.body, req.session?.user?.id)); }
    catch (error) { sendError(res, error); }
  });
  app.get(root + "/requests/:commandKey", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.params.commandKey, req.session?.user?.id)); }
    catch (error) { sendError(res, error); }
  });
}

export function registerInventoryProductSyncRoutes(app: Express,
  service: Pick<InventoryProductSyncService, "review" | "sync" | "progress"> = new InventoryProductSyncService(new PostgresInventoryProductSyncStore()),
): void {
  app.post(root + "/review", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { sendError(res, error); }
  });
  app.post(root + "/sync", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { const result = await service.sync(req.body, req.session?.user?.id); res.status(result.replayed ? 200 : 202).json(result); }
    catch (error) { sendError(res, error); }
  });
  app.get(root + "/commands/:commandKey", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.params.commandKey)); } catch (error) { sendError(res, error); }
  });
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "PRODUCT_SYNC_REQUEST_INVALID", message: "Choose one valid product and its current ATP review.", definitiveRejected: true } }); return;
  }
  if (error instanceof InventoryProductSyncError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, definitiveRejected: error.status < 500 } }); return;
  }
  if (error instanceof InventoryAvailabilityRuntimePublicationError) {
    res.status(409).json({ error: { code: error.code, message: error.message, definitiveRejected: true } }); return;
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  logger.error("inventory_product_sync_failed", { outcome: "unconfirmed", error_code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN" });
  res.status(503).json({ error: { code: "PRODUCT_SYNC_UNCONFIRMED", message: "The ATP sync result is not confirmed. Retry the same sync to recover its result.", definitiveRejected: false } });
}
