import type { Express } from "express";
import { ordersStorage } from "../orders";
import { requirePermission, requireInternalApiKey } from "../../routes/middleware";

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

  // --- SLA Monitoring ---

  // Get SLA alerts (at_risk + overdue orders)
  app.get("/api/sla/alerts", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const alerts = await slaMonitor.getSLAAlerts();
      res.json(alerts);
    } catch (error: any) {
      console.error("Error fetching SLA alerts:", error);
      res.status(500).json({ error: error.message || "Failed to fetch SLA alerts" });
    }
  });

  // Get SLA summary counts
  app.get("/api/sla/summary", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const summary = await slaMonitor.getSLASummary();
      res.json(summary);
    } catch (error: any) {
      console.error("Error fetching SLA summary:", error);
      res.status(500).json({ error: error.message || "Failed to fetch SLA summary" });
    }
  });

  // Manually trigger SLA status update
  app.post("/api/sla/update-statuses", requirePermission("orders", "manage"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const result = await slaMonitor.updateSLAStatuses();
      res.json({ message: "SLA statuses updated", ...result });
    } catch (error: any) {
      console.error("Error updating SLA statuses:", error);
      res.status(500).json({ error: error.message || "Failed to update SLA statuses" });
    }
  });

  // ===== OPERATIONS VIEW ENDPOINTS =====

  app.get("/api/operations/bin-inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getBinInventory({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        zone: (req.query.zone as string) || null,
        locationType: (req.query.locationType as string) || null,
        binType: (req.query.binType as string) || null,
        search: (req.query.search as string) || null,
        hasInventory: req.query.hasInventory === "true" ? true : req.query.hasInventory === "false" ? false : null,
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
        sortField: (req.query.sortField as string) || "code",
        sortDir: (req.query.sortDir as string) === "desc" ? "desc" as const : "asc" as const,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching bin inventory:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch bin inventory", detail: error?.message });
    }
  });

  app.get("/api/operations/unassigned-inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getUnassignedInventory({
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching unassigned inventory:", error);
      res.status(500).json({ error: "Failed to fetch unassigned inventory" });
    }
  });

  app.get("/api/operations/location-health", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getLocationHealth({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        staleDays: parseInt(req.query.staleDays as string) || 30,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching location health:", error);
      res.status(500).json({ error: "Failed to fetch location health" });
    }
  });

  app.get("/api/operations/exceptions", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getExceptions({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        staleDays: parseInt(req.query.staleDays as string) || 30,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ error: "Failed to fetch exceptions" });
    }
  });

  app.get("/api/operations/pick-readiness", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getPickReadiness({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        threshold: parseInt(req.query.threshold as string) || 5,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching pick readiness:", error);
      res.status(500).json({ error: "Failed to fetch pick readiness" });
    }
  });

  app.get("/api/operations/activity", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getActivity({
        locationId: req.query.locationId ? parseInt(req.query.locationId as string) : null,
        variantId: req.query.variantId ? parseInt(req.query.variantId as string) : null,
        limit: parseInt(req.query.limit as string) || 20,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching activity:", error);
      res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  app.get("/api/operations/action-queue", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
      const result = await ops.getActionQueue({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        filter: (req.query.filter as string) || "all",
        search: (req.query.search as string) || "",
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
        sortField: (req.query.sortField as string) || "priority",
        sortDir: (req.query.sortDir as string) === "desc" ? "desc" as const : "asc" as const,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching action queue:", error);
      res.status(500).json({ error: "Failed to fetch action queue" });
    }
  });

  // ===== INTERNAL API (for Archon cross-service sync) =====

  app.get("/api/internal/orders", requireInternalApiKey, async (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string) : null;

      const results = await ordersStorage.getOrdersWithShipments(since);

      // Deduplicate: an order may have multiple shipments — take the latest
      const orderMap = new Map<number, (typeof results)[number]>();
      for (const r of results) {
        const existing = orderMap.get(r.order.id);
        if (!existing || (r.shipment?.createdAt && (!existing.shipment?.createdAt || r.shipment.createdAt > existing.shipment.createdAt))) {
          orderMap.set(r.order.id, r);
        }
      }

      const orderList = Array.from(orderMap.values()).map(r => ({
        id: r.order.id,
        source: r.order.source,
        externalOrderId: r.order.externalOrderId,
        shopifyOrderId: r.order.shopifyOrderId,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customerName,
        customerEmail: r.order.customerEmail,
        warehouseStatus: r.order.warehouseStatus,
        orderPlacedAt: r.order.orderPlacedAt?.toISOString() ?? null,
        shipment: r.shipment ? {
          carrier: r.shipment.carrier,
          trackingNumber: r.shipment.trackingNumber,
          trackingUrl: r.shipment.trackingUrl,
          status: r.shipment.status,
          shippedAt: r.shipment.shippedAt?.toISOString() ?? null,
        } : null,
      }));

      res.json({
        orders: orderList,
        total: orderList.length,
        syncedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Internal API - orders error:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  app.get("/api/internal/shipments", requireInternalApiKey, async (req, res) => {
    try {
      const orderIdsParam = req.query.orderIds as string;
      if (!orderIdsParam) {
        return res.status(400).json({ error: "orderIds query parameter required" });
      }

      const orderIds = orderIdsParam.split(",").map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
      if (orderIds.length === 0) {
        return res.json({ shipments: [] });
      }

      const results = await ordersStorage.getShipmentsByOrderIds(orderIds);

      res.json({
        shipments: results.map((s: any) => ({
          orderId: s.orderId,
          carrier: s.carrier,
          trackingNumber: s.trackingNumber,
          trackingUrl: s.trackingUrl,
          status: s.status,
          shippedAt: s.shippedAt?.toISOString() ?? null,
        })),
      });
    } catch (error: any) {
      console.error("Internal API - shipments error:", error);
      res.status(500).json({ error: "Failed to fetch shipments" });
    }
  });
}
