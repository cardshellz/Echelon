import type { Express, Response } from "express";
import { prepareWarehouseInventorySourceResultSchema, warehouseInventorySourceViewSchema } from "@shared/types/warehouse-inventory-source";
import { requirePermission } from "../../../routes/middleware";
import { logger } from "../../../platform/observability/logger";
import { WarehouseInventorySourceService } from "../application/warehouse-inventory-source.service";
import { WarehouseInventorySourceError } from "../domain/warehouse-inventory-source";
import { PostgresWarehouseInventorySourceStore } from "../infrastructure/warehouse-inventory-source.repository";

export function registerWarehouseInventorySourceRoutes(
  app: Express,
  service: Pick<WarehouseInventorySourceService, "getView" | "prepareDraft"> =
    new WarehouseInventorySourceService(new PostgresWarehouseInventorySourceStore()),
): void {
  // Register before /api/warehouses/:id so the static resource cannot be mistaken for an ID.
  app.get("/api/warehouses/inventory-sources", requirePermission("inventory_planning", "view"), async (_req, res) => {
    try {
      return res.json(warehouseInventorySourceViewSchema.parse(await service.getView()));
    } catch (error) { return sendError(res, error); }
  });
  app.post("/api/warehouses/inventory-sources", requirePermission("inventory_planning", "edit"), async (req, res) => {
    try {
      const result = prepareWarehouseInventorySourceResultSchema.parse(
        await service.prepareDraft(req.body, req.session?.user?.id),
      );
      return res.status(result.alreadyApplied ? 200 : 201).json(result);
    } catch (error) { return sendError(res, error); }
  });
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof WarehouseInventorySourceError) {
    const level = error.classification === "fatal" ? "error"
      : error.classification === "transient" ? "warn" : "debug";
    logger[level]("warehouse.inventory_source.request", {
      outcome: "rejected", error_code: error.code, error_class: error.classification,
      before: null, after: null,
    });
    return res.status(error.status).json({ error: {
      code: error.code, message: error.message, classification: error.classification,
    } });
  }
  logger.error("warehouse.inventory_source.route", {
    outcome: "failed", error_code: "WAREHOUSE_INVENTORY_SOURCE_FAILED", before: null, after: null,
  });
  return res.status(500).json({ error: { code: "WAREHOUSE_INVENTORY_SOURCE_FAILED",
    message: "The warehouse source request failed.", classification: "fatal" } });
}
