import type { Express, Request, Response } from "express";

import { db } from "../../db";
import { hasPermission } from "../identity";
import { requireAuth, requirePermission } from "../../routes/middleware";
import {
  executeOperationsControlTowerAction,
  getOperationsControlTower,
  getOperationsControlTowerDetail,
  parseControlTowerFilters,
} from "./control-tower.service";

function operatorName(req: Request): string {
  return req.session.user?.username || req.session.user?.displayName || String(req.session.user?.id || "unknown");
}

function dependencies(req: Request) {
  const services = req.app.locals.services as any;
  return {
    db,
    operationsDashboard: services?.operationsDashboard,
    replenishment: services?.replenishment,
    shipmentTracking: services?.shipmentTracking,
    canViewProcurement: Boolean(req.session.user?.id),
  };
}

export function registerOperationsControlTowerRoutes(app: Express) {
  app.get("/api/operations/control-tower", requirePermission("inventory", "view"), async (req: Request, res: Response) => {
    try {
      const userId = req.session.user?.id;
      const canViewProcurement = userId ? await hasPermission(userId, "purchasing", "view") : false;
      const filters = parseControlTowerFilters(req.query);
      res.json(await getOperationsControlTower({ ...dependencies(req), canViewProcurement }, filters));
    } catch (error: any) {
      console.error("[Operations Control Tower] load failed:", error);
      res.status(500).json({ error: "Failed to load operations control tower" });
    }
  });

  app.get("/api/operations/control-tower/:id", requirePermission("inventory", "view"), async (req: Request, res: Response) => {
    try {
      const userId = req.session.user?.id;
      const canViewProcurement = userId ? await hasPermission(userId, "purchasing", "view") : false;
      const id = String(req.params.id || "").trim();
      if (!id || id.length > 200) {
        res.status(400).json({ error: "A valid work item id is required" });
        return;
      }
      const result = await getOperationsControlTowerDetail({ ...dependencies(req), canViewProcurement }, id);
      if (!result) {
        res.status(404).json({ error: "Control Tower work item not found or already resolved" });
        return;
      }
      res.json(result);
    } catch (error: any) {
      console.error("[Operations Control Tower] detail failed:", error);
      res.status(500).json({ error: "Failed to load operations control tower detail" });
    }
  });

  app.post("/api/operations/control-tower/:id/actions/:actionId", requireAuth, async (req: Request, res: Response) => {
    try {
      const actionId = String(req.params.actionId || "").trim();
      if (!/^[a-z_]+$/.test(actionId)) {
        res.status(400).json({ error: "Invalid action id" });
        return;
      }

      const userId = req.session.user?.id;
      const canViewProcurement = userId ? await hasPermission(userId, "purchasing", "view") : false;
      const itemId = String(req.params.id || "").trim();
      const detail = await getOperationsControlTowerDetail({ ...dependencies(req), canViewProcurement }, itemId);
      if (!detail) {
        res.status(404).json({ error: "Control Tower work item not found or already resolved" });
        return;
      }

      const requiresInventoryAdjust = detail.domain === "wms";
      const requiresOrderExceptionResolution = detail.domain === "oms" || detail.domain === "shipping";
      if (requiresInventoryAdjust && (!userId || !(await hasPermission(userId, "inventory", "adjust")))) {
        res.status(403).json({ error: "Permission denied: inventory:adjust" });
        return;
      }
      if (requiresOrderExceptionResolution && (!userId || !(await hasPermission(userId, "orders", "resolve_exception")))) {
        res.status(403).json({ error: "Permission denied: orders:resolve_exception" });
        return;
      }

      const result = await executeOperationsControlTowerAction({
        deps: { ...dependencies(req), canViewProcurement },
        id: itemId,
        actionId,
        record: req.body?.record,
        operator: operatorName(req),
        detail,
      });
      res.json({ accepted: true, workItemId: itemId, actionId, result });
    } catch (error: any) {
      console.error("[Operations Control Tower] action failed:", error);
      const message = error?.message || "Failed to execute control tower action";
      const status = /not found/i.test(message) ? 404 : /permission|positive integer|required|invalid/i.test(message) ? 400 : 409;
      res.status(status).json({ error: message });
    }
  });
}
