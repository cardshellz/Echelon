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

  app.post("/api/operations/pick-replen-health/cleanup", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services;
      const mode = typeof req.body?.mode === "string" ? req.body.mode : "all";
      const taskId = req.body?.taskId != null && Number.isInteger(Number(req.body.taskId))
        ? Number(req.body.taskId)
        : null;
      const limit = req.body?.limit != null && Number.isInteger(Number(req.body.limit))
        ? Number(req.body.limit)
        : undefined;
      if (mode === "queue_replen") {
        const variantId = Number(req.body?.variantId);
        const locationId = Number(req.body?.locationId);
        if (!Number.isInteger(variantId) || !Number.isInteger(locationId)) {
          return res.status(400).json({ error: "variantId and locationId are required to queue replen" });
        }

        const result = await replenishment.queueMissingPickBinReplen({
          mode,
          variantId,
          locationId,
          warehouseId: req.body?.warehouseId ? Number(req.body.warehouseId) : null,
          limit: 1,
        });
        return res.json({
          ...result,
          queuedTaskId: result.queuedTaskIds[0] ?? null,
          cancelledStaleNoDemand: 0,
          cancelledStaleBacklog: 0,
          cancelledDuplicates: 0,
          cancelledStaleNoDemandTaskIds: [],
          cancelledStaleBacklogTaskIds: [],
          cancelledDuplicateTaskIds: [],
          keptDuplicateTaskIds: [],
        });
      }

      if (mode === "queue_missing_replen") {
        const result = await replenishment.queueMissingPickBinReplen({
          mode,
          warehouseId: req.body?.warehouseId ? Number(req.body.warehouseId) : null,
          limit,
        });
        return res.json({
          ...result,
          queuedTaskId: result.queuedTaskIds[0] ?? null,
          cancelledStaleNoDemand: 0,
          cancelledStaleBacklog: 0,
          cancelledDuplicates: 0,
          cancelledStaleNoDemandTaskIds: [],
          cancelledStaleBacklogTaskIds: [],
          cancelledDuplicateTaskIds: [],
          keptDuplicateTaskIds: [],
        });
      }

      const result = await replenishment.cleanupHealthIssues({
        mode,
        taskId,
        warehouseId: req.body?.warehouseId ? Number(req.body.warehouseId) : null,
        limit,
        userId: req.session.user?.id,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error cleaning pick/replen health:", error?.message || error);
      res.status(500).json({ error: error?.message || "Failed to clean pick/replen health" });
    }
  });
}
