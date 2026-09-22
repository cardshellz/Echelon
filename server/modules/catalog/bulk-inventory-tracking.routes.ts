import type { Express, Response } from "express";
import { BULK_INVENTORY_TRACKING_PATH, bulkInventoryTrackingApplySchema,
  bulkInventoryTrackingRequestSchema, bulkInventoryTrackingPreviewSchema,
  bulkInventoryTrackingResultSchema } from "@shared/catalog/bulk-inventory-tracking";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { createBulkInventoryTrackingService } from "./bulk-inventory-tracking.service";

function sendError(res: Response, error: unknown): Response {
  if (error instanceof FinancialCommandError) {
    for (const [key, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(key, value);
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  console.error(JSON.stringify({ event: "catalog.inventory_tracking_bulk.failed", code: "BULK_INVENTORY_TRACKING_FAILED",
    message: error instanceof Error ? error.message : "Unknown failure" }));
  return res.status(500).json({ error: "Unable to complete the inventory tracking request. Retry the same request.",
    code: "BULK_INVENTORY_TRACKING_FAILED" });
}

export function registerBulkInventoryTrackingRoutes(
  app: Express, service = createBulkInventoryTrackingService(),
): void {
  app.post(`${BULK_INVENTORY_TRACKING_PATH}/preview`, requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const input = bulkInventoryTrackingRequestSchema.safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: "Invalid inventory tracking selection", code: "BULK_INVENTORY_TRACKING_INVALID" });
      const preview = await service.preview(input.data);
      res.setHeader("Cache-Control", "no-store");
      // Validate output separately so a broken server response is never a 400.
      if (!bulkInventoryTrackingPreviewSchema.safeParse(preview).success) throw new Error("Invalid inventory tracking preview response");
      return res.json(preview);
    } catch (error) { return sendError(res, error); }
  });
  app.post(`${BULK_INVENTORY_TRACKING_PATH}/apply`, requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const input = bulkInventoryTrackingApplySchema.safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: "Invalid inventory tracking selection", code: "BULK_INVENTORY_TRACKING_INVALID" });
      const descriptor = financialCommandFromRequest(req, { routeTemplate: `${BULK_INVENTORY_TRACKING_PATH}/apply`,
        resourceKey: "product-inventory-tracking", commandName: "catalog.inventory_tracking.bulk" });
      const result = await service.apply(input.data, descriptor);
      if (result.terminalState === "succeeded" && !bulkInventoryTrackingResultSchema.safeParse(result.body).success) {
        throw new Error("Invalid inventory tracking result response");
      }
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.setHeader("Cache-Control", "no-store");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) { return sendError(res, error); }
  });
}
