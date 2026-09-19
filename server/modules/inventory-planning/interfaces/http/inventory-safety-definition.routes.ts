import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { SafetyDefinitionService } from "../../application/inventory-safety-definition.service";
import { PostgresSafetyDefinitionStore } from "../../infrastructure/inventory-safety-definition.repository";
import { sendError } from "./inventory-product-definition.routes";

export function registerSafetyDefinitionRoutes(app: Express,
  service: Pick<SafetyDefinitionService, "review" | "apply" | "progress"> = new SafetyDefinitionService(new PostgresSafetyDefinitionStore()),
): void {
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
