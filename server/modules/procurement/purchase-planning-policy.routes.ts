import type { Express, Request } from "express";
import { requirePermission } from "../../routes/middleware";
import { PurchasePlanningPolicyError, PurchasePlanningPolicyService } from "./purchase-planning-policy.service";

import { getPurchasePlanningPolicyService } from "./purchase-planning-policy.runtime";

export function registerPurchasePlanningPolicyRoutes(app: Express, service = getPurchasePlanningPolicyService()): void {
  app.get("/api/purchasing/planning-policy", requirePermission("purchasing", "view"), async (_req, res) => {
    try { const record = await service.read(); res.json({ ...record, products: await service.describeProducts([...new Set([...record.policy.products.map((product) => product.productId), ...(record.policy.replacementForecasts ?? []).map((range) => range.productId)])]) }); }
    catch (error) { console.error("[PurchasePlanningPolicy] Read failed", error); res.status(500).json({ code: "PLANNING_POLICY_READ_FAILED", error: "Unable to load planning policy" }); }
  });
  app.get("/api/purchasing/planning-policy/products", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json({ items: await service.searchProducts(req.query.search) }); }
    catch (error) {
      if (error instanceof PurchasePlanningPolicyError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
      console.error("[PurchasePlanningPolicy] Product search failed", error);
      res.status(500).json({ code: "PLANNING_PRODUCT_SEARCH_FAILED", error: "Unable to search products" });
    }
  });
  app.get("/api/purchasing/planning-policy/history", requirePermission("purchasing", "view"), async (_req, res) => {
    try { res.json({ changes: await service.history() }); }
    catch (error) { console.error("[PurchasePlanningPolicy] History read failed", error); res.status(500).json({ code: "PLANNING_POLICY_HISTORY_FAILED", error: "Unable to load planning policy history" }); }
  });
  app.put("/api/purchasing/planning-policy", requirePermission("purchasing", "edit"), async (req, res) => {
    try { res.json(await service.update(req.body, (req as Request & { user?: { id?: unknown } }).user?.id ?? req.session?.user?.id)); }
    catch (error) {
      if (error instanceof PurchasePlanningPolicyError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
      console.error("[PurchasePlanningPolicy] Update failed", error);
      res.status(500).json({ code: "PLANNING_POLICY_UPDATE_FAILED", error: "Unable to save planning policy. Retry the same request key." });
    }
  });
}
