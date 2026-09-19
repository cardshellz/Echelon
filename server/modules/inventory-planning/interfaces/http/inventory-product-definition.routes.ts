import type { Express, Response } from "express";
import { ZodError } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { ProductDefinitionError, ProductDefinitionService } from "../../application/inventory-product-definition.service";
import { PostgresProductDefinitionStore } from "../../infrastructure/inventory-product-definition.repository";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";

export function registerProductDefinitionRoutes(app: Express,
  service: Pick<ProductDefinitionService, "review" | "apply" | "progress"> = new ProductDefinitionService(new PostgresProductDefinitionStore()),
): void {
  app.post("/api/inventory-planning/admin/product-definitions/review", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { sendError(res, error); }
  });
  app.post("/api/inventory-planning/admin/product-definitions/apply", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.apply(req.body, req.session?.user?.id)); } catch (error) { sendError(res, error); }
  });
  app.get("/api/inventory-planning/admin/product-definitions/:productId/progress", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(Number(req.params.productId))); } catch (error) { sendError(res, error); }
  });
}
export function sendError(res: Response, error: unknown): void {
  if (error instanceof ZodError) { res.status(400).json({ error: { code: "DEFINITION_INVALID_REQUEST", message: "A valid draft selection and authenticated actor are required." } }); return; }
  if (error instanceof ProductDefinitionError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  if (error instanceof InventoryAvailabilityRuntimePublicationError) {
    res.status(409).json({ error: { code: "DEFINITION_PUBLICATION_BLOCKED", message: "An affected channel destination is not ready for publication. Resolve its inventory-publication blockers, then review again." } }); return;
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  if (["40001", "40P01", "55P03", "57014", "INVENTORY_PUBLICATION_TARGET_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY"].includes(code)) {
    res.status(409).json({ error: { code: "DEFINITION_BUSY", message: "Inventory changed or another operation is in progress. Review again before retrying." } }); return;
  }
  console.error(JSON.stringify({ event: "product_definition_command_failed", code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN" }));
  res.status(500).json({ error: { code: "DEFINITION_COMMAND_FAILED", message: "The result is not confirmed. Retry with the same command key." } });
}
