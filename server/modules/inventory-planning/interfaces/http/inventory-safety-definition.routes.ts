import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { SafetyDefinitionService } from "../../application/inventory-safety-definition.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { PostgresSafetyDefinitionStore } from "../../infrastructure/inventory-safety-definition.repository";
import { sendError } from "./inventory-product-definition.routes";

export function registerSafetyDefinitionRoutes(app: Express,
  service: Pick<SafetyDefinitionService, "review" | "apply" | "progress" | "set" | "overview"> = new SafetyDefinitionService(new PostgresSafetyDefinitionStore()),
): void {
  const respondToSet = (res: Parameters<typeof sendError>[0], error: unknown) => {
    // Set runs the version writers, which report a moved head or an unusable SKU with their own typed error.
    if (error instanceof InventoryAvailabilityMasterDataError) {
      if (error.status >= 500) console.error(JSON.stringify({ level: "error", event: "safety_definition_set_failed", error_code: error.code }));
      res.status(error.status).json({ error: { code: error.code, message: error.message,
        ...(error.details.length > 0 ? { details: [...error.details] } : {}) } });
      return;
    }
    // Promotion re-checks the reviewed head. Under the fence nothing else can move
    // it, so this is a definite rejection (rolled back), not an unknown outcome.
    if (error instanceof InventoryCutoverManifestError && error.code === "CUTOVER_REVIEWED_HEAD_CHANGED") {
      res.status(409).json({ error: { code: "DEFINITION_REVIEW_STALE", message: "This setting changed while saving. Nothing was saved; reload and try again." } });
      return;
    }
    sendError(res, error);
  };
  app.get("/api/inventory-planning/admin/safety-definitions/overview", requirePermission("inventory_planning", "view"), async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.overview()); } catch (error) { sendError(res, error); }
  });
  // Set both saves and applies, so it needs both permissions the two separate steps need.
  app.post("/api/inventory-planning/admin/safety-definitions/set", requirePermission("inventory_planning", "edit"),
    requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.set(req.body, req.session?.user?.id)); } catch (error) { respondToSet(res, error); }
  });
  app.post("/api/inventory-planning/admin/safety-definitions/review", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { sendError(res, error); }
  });
  app.post("/api/inventory-planning/admin/safety-definitions/apply", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.apply(req.body, req.session?.user?.id)); } catch (error) { sendError(res, error); }
  });
  app.get("/api/inventory-planning/admin/safety-definitions/progress", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.query.scopeKey)); } catch (error) { sendError(res, error); }
  });
}
