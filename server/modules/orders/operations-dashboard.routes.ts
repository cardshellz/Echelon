import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";

export function registerOperationsDashboardRoutes(app: Express) {
  app.get("/api/operations/pick-replen-health", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getPickReplenHealth({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        filter: (req.query.filter as string) || "all",
        search: (req.query.search as string) || "",
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching pick/replen health:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch pick/replen health" });
    }
  });
}
