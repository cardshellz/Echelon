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

        const task = await replenishment.checkAndTriggerAfterPick(variantId, locationId, "health_queue", {
          blocksShipment: false,
        });
        return res.json({
          mode,
          queuedReplen: task ? 1 : 0,
          queuedTaskId: task?.id ?? null,
          cancelledStaleNoDemand: 0,
          cancelledDuplicates: 0,
          cancelledStaleNoDemandTaskIds: [],
          cancelledDuplicateTaskIds: [],
          keptDuplicateTaskIds: [],
        });
      }

      const result = await replenishment.cleanupHealthIssues({
        mode,
        taskId,
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
