import type { Express, Request, Response } from "express";

import { db, pool } from "../../db";
import { hasPermission } from "../identity";
import { requireAuth, requirePermission } from "../../routes/middleware";
import {
  executeOperationsControlTowerAction,
  getOperationsControlTower,
  getOperationsControlTowerDetail,
  parseControlTowerFilters,
} from "./control-tower.service";
import { getControlTowerFlowOverview } from "./control-tower-flow-snapshot.service";
import {
  getControlTowerV2Assignees,
  getControlTowerV2Detail,
  getControlTowerV2GroupDetail,
  getControlTowerV2Sources,
  loadControlTowerV2Groups,
  loadControlTowerV2Queue,
  parseControlTowerV2GroupKey,
  parseControlTowerV2QueueFilters,
} from "./control-tower-v2.query";
import {
  ControlTowerRequestError,
  parsePositiveWorkItemId,
  parseWorkItemVersion,
} from "./control-tower-v2.request";
import {
  acknowledgeControlTowerV2Item,
  assignControlTowerV2Item,
  snoozeControlTowerV2Item,
} from "./control-tower-v2.triage";

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
    flowReconciliation: services?.channelFulfillmentAuthority
      ? {
          reservation: services?.reservation ?? null,
          fulfillmentAuthority: services.channelFulfillmentAuthority,
        }
      : undefined,
    canViewProcurement: Boolean(req.session.user?.id),
  };
}

export function registerOperationsControlTowerRoutes(app: Express) {
  app.get(
    "/api/operations/control-tower/v2/flow-overview",
    requirePermission("operations", "view"),
    async (_req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
        res.json(await getControlTowerFlowOverview(pool));
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower flow overview");
      } finally {
        logSlowControlTowerRequest("flow-overview", startedAt);
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/groups",
    requirePermission("operations", "view"),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const filters = parseControlTowerV2QueueFilters(req.query as Record<string, unknown>);
        const result = await loadControlTowerV2Groups({ client: pool, filters });
        res.setHeader("Cache-Control", "private, no-store");
        res.json(result);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower issue groups");
      } finally {
        logSlowControlTowerRequest("groups", startedAt, { view: req.query.view ?? "attention" });
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/groups/:groupKey",
    requirePermission("operations", "view"),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const filters = parseControlTowerV2QueueFilters(req.query as Record<string, unknown>);
        const groupKey = parseControlTowerV2GroupKey(req.params.groupKey);
        const detail = await getControlTowerV2GroupDetail({ client: pool, filters, groupKey });
        if (!detail) {
          res.status(404).json({ error: "Control Tower issue group not found" });
          return;
        }
        res.setHeader("Cache-Control", "private, no-store");
        res.json(detail);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower issue group");
      } finally {
        logSlowControlTowerRequest("group-detail", startedAt, { groupKey: req.params.groupKey });
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/work-items",
    requirePermission("operations", "view"),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const filters = parseControlTowerV2QueueFilters(req.query as Record<string, unknown>);
        const result = await loadControlTowerV2Queue({ client: pool, filters });
        res.setHeader("Cache-Control", "private, no-store");
        res.json(result);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower queue");
      } finally {
        logSlowControlTowerRequest("queue", startedAt, { view: req.query.view ?? "attention" });
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/sources",
    requirePermission("operations", "view"),
    async (_req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        res.setHeader("Cache-Control", "private, no-store");
        res.json(await getControlTowerV2Sources(pool));
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower source health");
      } finally {
        logSlowControlTowerRequest("sources", startedAt);
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/assignees",
    requirePermission("operations", "assign"),
    async (_req: Request, res: Response) => {
      try {
        res.setHeader("Cache-Control", "private, no-store");
        res.json(await getControlTowerV2Assignees(pool));
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower assignees");
      }
    },
  );

  app.get(
    "/api/operations/control-tower/v2/work-items/:id",
    requirePermission("operations", "view"),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const id = parsePositiveWorkItemId(req.params.id);
        const requestedTechnical = String(req.query.includeTechnical ?? "") === "1";
        const userId = req.session.user!.id;
        const includeTechnicalEvidence = requestedTechnical
          && await hasPermission(userId, "operations", "view_technical");
        if (requestedTechnical && !includeTechnicalEvidence) {
          res.status(403).json({ error: "Permission denied: operations:view_technical" });
          return;
        }
        const detail = await getControlTowerV2Detail({ client: pool, id, includeTechnicalEvidence });
        if (!detail) {
          res.status(404).json({ error: "Control Tower work item not found" });
          return;
        }
        res.setHeader("Cache-Control", "private, no-store");
        res.json(detail);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to load Control Tower detail");
      } finally {
        logSlowControlTowerRequest("detail", startedAt, { workItemId: req.params.id });
      }
    },
  );

  app.post(
    "/api/operations/control-tower/v2/work-items/:id/acknowledge",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
      try {
        const result = await acknowledgeControlTowerV2Item({
          pool,
          id: parsePositiveWorkItemId(req.params.id),
          version: parseWorkItemVersion(req.body?.version),
          actorUserId: req.session.user!.id,
          note: req.body?.note,
        });
        res.json(result);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to acknowledge Control Tower item");
      }
    },
  );

  app.post(
    "/api/operations/control-tower/v2/work-items/:id/assign",
    requirePermission("operations", "assign"),
    async (req: Request, res: Response) => {
      try {
        const result = await assignControlTowerV2Item({
          pool,
          id: parsePositiveWorkItemId(req.params.id),
          version: parseWorkItemVersion(req.body?.version),
          actorUserId: req.session.user!.id,
          assignedUserId: req.body?.assignedUserId,
          ownerTeam: req.body?.ownerTeam,
          note: req.body?.note,
        });
        res.json(result);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to assign Control Tower item");
      }
    },
  );

  app.post(
    "/api/operations/control-tower/v2/work-items/:id/snooze",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
      try {
        const result = await snoozeControlTowerV2Item({
          pool,
          id: parsePositiveWorkItemId(req.params.id),
          version: parseWorkItemVersion(req.body?.version),
          actorUserId: req.session.user!.id,
          until: req.body?.until,
          reason: req.body?.reason,
        });
        res.json(result);
      } catch (error) {
        sendControlTowerV2Error(res, error, "Failed to snooze Control Tower item");
      }
    },
  );

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

function sendControlTowerV2Error(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ControlTowerRequestError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  console.error(`[Operations Control Tower V2] ${fallback}`, error);
  res.status(500).json({ error: fallback, code: "CONTROL_TOWER_INTERNAL_ERROR" });
}

function logSlowControlTowerRequest(
  endpoint: string,
  startedAt: number,
  context: Record<string, unknown> = {},
): void {
  const durationMs = Date.now() - startedAt;
  if (durationMs < 750) return;
  console.warn("[Operations Control Tower V2] slow request", {
    endpoint,
    durationMs,
    ...context,
  });
}
