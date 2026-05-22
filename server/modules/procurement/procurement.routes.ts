import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission, requireAuth, requireInternalApiKey } from "../../routes/middleware";
import { registerReplenishmentRoutes } from "../inventory/replenishment.routes";
import { registerNotificationRoutes } from "../notifications/notifications.routes";
import { registerReceivingRoutes } from "./receiving.routes";
import { registerPurchaseOrderRoutes } from "./purchase-order.routes";
import { registerPurchasingAdminRoutes } from "./purchasing-admin.routes";
import { registerInboundShipmentRoutes } from "./inbound-shipment.routes";
import { registerApLedgerRoutes } from "./ap-ledger.routes";
import { registerProcurementReportRoutes } from "./procurement-report.routes";
import { registerProcurementHealthRoutes } from "./procurement-health.routes";
import {
  registerPurchasingRecommendationAdminRoutes,
  registerPurchasingRecommendationRoutes,
} from "./purchasing-recommendation.routes";

export function registerPurchasingRoutes(app: Express) {
  // ===== VENDORS API =====
  
  app.get("/api/vendors", requireAuth, async (req, res) => {
    try {
      const vendors = await storage.getAllVendors();
      res.json(vendors);
    } catch (error) {
      console.error("Error fetching vendors:", error);
      res.status(500).json({ error: "Failed to fetch vendors" });
    }
  });
  
  app.get("/api/vendors/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const vendor = await storage.getVendorById(id);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error fetching vendor:", error);
      res.status(500).json({ error: "Failed to fetch vendor" });
    }
  });
  
  app.post("/api/vendors", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { code, name, contactName, email, phone, address, notes } = req.body;
      if (!code || !name) {
        return res.status(400).json({ error: "Code and name are required" });
      }
      
      const existing = await storage.getVendorByCode(code);
      if (existing) {
        return res.status(400).json({ error: "Vendor code already exists" });
      }
      
      const vendor = await storage.createVendor({
        code,
        name,
        contactName,
        email,
        phone,
        address,
        notes,
      });
      res.status(201).json(vendor);
    } catch (error) {
      console.error("Error creating vendor:", error);
      res.status(500).json({ error: "Failed to create vendor" });
    }
  });
  
  app.patch("/api/vendors/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const vendor = await storage.updateVendor(id, updates);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error updating vendor:", error);
      res.status(500).json({ error: "Failed to update vendor" });
    }
  });
  
  app.delete("/api/vendors/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteVendor(id);
      if (!deleted) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting vendor:", error);
      res.status(500).json({ error: "Failed to delete vendor" });
    }
  });
  
  registerReceivingRoutes(app);

  registerReplenishmentRoutes(app);

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

  registerPurchasingRecommendationRoutes(app);

  // ===== INTERNAL API (for Archon cross-service sync) =====

  app.get("/api/internal/orders", requireInternalApiKey, async (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string) : null;

      const results = await storage.getOrdersWithShipments(since);

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

      const results = await storage.getShipmentsByOrderIds(orderIds);

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

  // ==========================================================================
  // PURCHASING - Purchase Orders, Vendor Products, Approval Tiers
  // ==========================================================================

  registerPurchaseOrderRoutes(app);
  registerPurchasingAdminRoutes(app);

  registerProcurementReportRoutes(app);
  registerProcurementHealthRoutes(app);

  registerInboundShipmentRoutes(app);

  registerApLedgerRoutes(app);

  registerNotificationRoutes(app);

  registerPurchasingRecommendationAdminRoutes(app);
}
