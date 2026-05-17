import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission, requireAuth, requireInternalApiKey } from "../../routes/middleware";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { registerReplenishmentRoutes } from "../inventory/replenishment.routes";
import { registerNotificationRoutes } from "../notifications/notifications.routes";
import { registerReceivingRoutes } from "./receiving.routes";
import { registerPurchaseOrderRoutes } from "./purchase-order.routes";
import { registerPurchasingAdminRoutes } from "./purchasing-admin.routes";
import { registerInboundShipmentRoutes } from "./inbound-shipment.routes";
import { registerApLedgerRoutes } from "./ap-ledger.routes";
import { registerProcurementReportRoutes } from "./procurement-report.routes";

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

  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/kpis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);

      // Global defaults for lead time / safety stock when product is unconfigured.
      // See procurement.storage.getDashboardData for the same hierarchy.
      const defaultsQuery = await db.execute(sql`
        SELECT key, value FROM warehouse.echelon_settings
        WHERE key IN ('default_lead_time_days','default_safety_stock_days')
      `);
      const defaultsMap = new Map<string, string>();
      for (const row of defaultsQuery.rows as any[]) defaultsMap.set(row.key, row.value);
      const defaultLeadTimeDays =
        Number.parseInt(defaultsMap.get("default_lead_time_days") ?? "14", 10) || 14;
      const defaultSafetyStockDays =
        Number.parseInt(defaultsMap.get("default_safety_stock_days") ?? "7", 10) || 7;

      let criticalRestocks = 0;
      let upcomingRestocks = 0;
      let idleCapitalCents = 0;

      rawRows.forEach((r: any) => {
        const totalOnHand = Number(r.total_pieces) || 0;
        const totalReserved = Number(r.total_reserved_pieces) || 0;
        const totalOutbound = Number(r.total_outbound_pieces) || 0;
        const onOrderPieces = Number(r.on_order_pieces) || 0;
        const leadTimeDays =
          r.lead_time_days == null || Number.isNaN(Number(r.lead_time_days))
            ? defaultLeadTimeDays
            : Number(r.lead_time_days);
        const safetyStockDays =
          r.safety_stock_days == null || Number.isNaN(Number(r.safety_stock_days))
            ? defaultSafetyStockDays
            : Number(r.safety_stock_days);
        const costCents = Number(r.unit_cost_cents) || 0;
        
        const available = totalOnHand - totalReserved;
        const avgDailyUsage = configuredLookback > 0 ? totalOutbound / configuredLookback : 0;
        const daysOfSupply = avgDailyUsage > 0 ? Math.round(available / avgDailyUsage) : available > 0 ? 9999 : 0;
        const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);
        const effectiveSupply = available + onOrderPieces;

        // KPI Calculations
        if (effectiveSupply < reorderPoint) {
          criticalRestocks++;
        } else if (effectiveSupply < (reorderPoint + (14 * avgDailyUsage)) && avgDailyUsage > 0) {
          upcomingRestocks++;
        }

        if (daysOfSupply > 180 && totalOnHand > 0) {
          idleCapitalCents += (totalOnHand * costCents);
        }
      });

      // Pipeline Value Calculation
      const openPoSummary = await storage.getOpenPoSummaryReport();
      let inboundPipelineValueCents = 0;
      let totalOpenLines = 0;
      openPoSummary.forEach((po) => {
        if (['approved', 'sent', 'acknowledged', 'partially_received'].includes(po.status)) {
          inboundPipelineValueCents += Number(po.total_value_cents) || 0;
          totalOpenLines += Number(po.total_lines) || 0;
        }
      });

      res.json({
        criticalRestocks,
        upcomingRestocks,
        idleCapitalCents,
        inboundPipelineValueCents,
        totalOpenLines,
        lastComputedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error fetching purchasing dashboard KPIs:", error);
      res.status(500).json({ error: "Failed to fetch purchasing dashboard KPIs" });
    }
  });

  app.post("/api/purchasing/auto-draft-run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { purchasing } = app.locals.services;
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      
      const itemsToOrder: Array<{
        productId: number;
        productVariantId: number;
        suggestedQty: number;
      }> = [];

      rawRows.forEach((r: any) => {
        const totalOnHand = Number(r.total_pieces) || 0;
        const totalReserved = Number(r.total_reserved_pieces) || 0;
        const totalOutbound = Number(r.total_outbound_pieces) || 0;
        const onOrderPieces = Number(r.on_order_pieces) || 0;
        const leadTimeDays = Number(r.lead_time_days) || 0;
        const safetyStockDays = Number(r.safety_stock_days) || 0;
        
        const available = totalOnHand - totalReserved;
        const avgDailyUsage = configuredLookback > 0 ? totalOutbound / configuredLookback : 0;
        const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);
        const effectiveSupply = available + onOrderPieces;

        if (effectiveSupply < reorderPoint) {
            const rawOrderQtyPieces = Math.max(0, reorderPoint - effectiveSupply);
            const orderUomUnits = Number(r.order_uom_units) || 1;
            const suggestedOrderQty = orderUomUnits > 1
                ? Math.ceil(rawOrderQtyPieces / orderUomUnits)
                : Math.ceil(rawOrderQtyPieces);
            
            if (suggestedOrderQty > 0) {
                itemsToOrder.push({
                    productId: r.product_id,
                    productVariantId: r.highest_hierarchy_variant_id || r.product_variant_id, // Default to highest UOM
                    suggestedQty: suggestedOrderQty,
                });
            }
        }
      });

      if (itemsToOrder.length > 0) {
        const result = await purchasing.createPOFromReorder(itemsToOrder, req.session?.user?.id || 'SYSTEM');
        res.json({ success: true, pos: result, count: result.length, itemsDrafted: itemsToOrder.length });
      } else {
        res.json({ success: true, count: 0, itemsDrafted: 0 });
      }

    } catch (error) {
      console.error("Error running auto-draft:", error);
      res.status(500).json({ error: "Failed to run auto-draft" });
    }
  });

  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/reorder-analysis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      // Use velocity_lookback_days from warehouse_settings as the default lookback
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;

      // Product-level query: aggregate inventory and velocity in base units (pieces)
      // Also fetch the highest-level variant (ordering UOM) for rounding order quantities
      const rawRows = await storage.getReorderAnalysisData(lookbackDays);

      // Apply exclusion filtering (reorder_excluded flag + exclusion rules)
      const { db } = await import("../../db");
      const { products: productsTable, reorderExclusionRules: exclRules } = await import("../../storage/base");
      const { sql: sqlFn } = await import("drizzle-orm");
      const allRules = await db.select().from(exclRules);
      const excludedIds = new Set<number>();
      if (allRules.length > 0) {
        const metaRows = await db.execute(sqlFn`SELECT id, category, brand, product_type, sku, reorder_excluded FROM ${productsTable} WHERE is_active = true`);
        for (const pm of metaRows.rows as any[]) {
          if (pm.reorder_excluded) { excludedIds.add(pm.id); continue; }
          for (const r of allRules) {
            const val = String(r.value).toLowerCase();
            let match = false;
            switch (r.field) {
              case "category": match = (pm.category || "").toLowerCase() === val; break;
              case "brand": match = (pm.brand || "").toLowerCase() === val; break;
              case "product_type": match = (pm.product_type || "").toLowerCase() === val; break;
              case "sku_prefix": match = (pm.sku || "").toLowerCase().startsWith(val); break;
              case "sku_exact": match = (pm.sku || "").toLowerCase() === val; break;
            }
            if (match) { excludedIds.add(pm.id); break; }
          }
        }
      }
      const rowsToProcess = allRules.length > 0 ? rawRows.filter((r: any) => !excludedIds.has(r.product_id)) : rawRows;
      const excludedCount = rawRows.length - rowsToProcess.length;

      const HIERARCHY_LABELS: Record<number, string> = { 1: "Pack", 2: "Box", 3: "Case", 4: "Skid" };

      const items = rowsToProcess.map((r: any) => {
        const totalOnHand = Number(r.total_pieces);
        const totalReserved = Number(r.total_reserved_pieces);
        const totalOutbound = Number(r.total_outbound_pieces);
        const onOrderPieces = Number(r.on_order_pieces);
        const openPoCount = Number(r.open_po_count);
        const earliestExpectedDate = r.earliest_expected || null;
        const leadTimeDays = Number(r.lead_time_days);
        const safetyStockDays = Number(r.safety_stock_days);
        const available = totalOnHand - totalReserved;
        const avgDailyUsage = lookbackDays > 0 ? totalOutbound / lookbackDays : 0;
        const daysOfSupply = avgDailyUsage > 0 ? Math.round(available / avgDailyUsage) : available > 0 ? 9999 : 0;
        const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);

        // Effective supply = available (unreserved) + on order
        const effectiveSupply = available + onOrderPieces;
        const rawOrderQtyPieces = Math.max(0, reorderPoint - effectiveSupply);

        // Round up to ordering UOM (highest hierarchy variant)
        const orderUomUnits = Number(r.order_uom_units) || 1;
        const orderUomLevel = Number(r.order_uom_level) || 0;
        const orderUomLabel = HIERARCHY_LABELS[orderUomLevel] || (orderUomUnits > 1 ? `${orderUomUnits}pk` : "pcs");
        const suggestedOrderQty = orderUomUnits > 1
          ? Math.ceil(rawOrderQtyPieces / orderUomUnits) // in ordering units (cases, boxes, etc.)
          : Math.ceil(rawOrderQtyPieces); // fallback: pieces
        const suggestedOrderPieces = suggestedOrderQty * orderUomUnits;

        // On-order qty in ordering UOM
        const onOrderQty = orderUomUnits > 1
          ? Math.floor(onOrderPieces / orderUomUnits)
          : onOrderPieces;

        let status: string;
        // Stockout = no available pieces regardless of velocity
        if (available <= 0) {
          status = "stockout";
        } else if (avgDailyUsage === 0) {
          status = "no_movement";
        } else if (available <= reorderPoint && onOrderPieces > 0 && effectiveSupply >= reorderPoint) {
          // Below reorder point but on-order covers the gap
          status = "on_order";
        } else if (available <= reorderPoint) {
          status = "order_now";
        } else if (daysOfSupply <= leadTimeDays * 1.5) {
          status = "order_soon";
        } else {
          status = "ok";
        }

        return {
          productId: r.product_id,
          productVariantId: r.variant_id ? Number(r.variant_id) : undefined,
          sku: r.base_sku || r.product_name,
          productName: r.product_name,
          variantCount: Number(r.variant_count || 0),
          totalOnHand,
          totalReserved,
          available,
          periodUsage: totalOutbound,
          avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
          daysOfSupply,
          leadTimeDays,
          safetyStockDays,
          reorderPoint,
          suggestedOrderQty,
          suggestedOrderPieces,
          orderUomUnits,
          orderUomLabel,
          onOrderQty,
          onOrderPieces,
          openPoCount,
          earliestExpectedDate,
          status,
          lastReceivedAt: r.last_received_at,
        };
      });

      const summary = {
        totalProducts: items.length,
        outOfStock: items.filter((i) => i.status === "stockout").length,
        belowReorderPoint: items.filter((i) => i.status === "order_now").length,
        orderSoon: items.filter((i) => i.status === "order_soon").length,
        noMovement: items.filter((i) => i.status === "no_movement").length,
        totalOnHand: items.reduce((s, i) => s + i.totalOnHand, 0),
      };

      res.json({ items, summary: { ...summary, excludedCount }, lookbackDays });
    } catch (error) {
      console.error("Error fetching reorder analysis:", error);
      res.status(500).json({ error: "Failed to fetch reorder analysis" });
    }
  });

  // PATCH velocity lookback days
  app.patch("/api/purchasing/velocity-lookback", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const days = parseInt(req.body.days);
      if (!days || days < 7 || days > 365) {
        return res.status(400).json({ error: "Days must be between 7 and 365" });
      }
      await storage.updateVelocityLookbackDays(days);
      res.json({ ok: true, days });
    } catch (error) {
      console.error("Error updating velocity lookback:", error);
      res.status(500).json({ error: "Failed to update velocity lookback" });
    }
  });

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

  registerInboundShipmentRoutes(app);

  registerApLedgerRoutes(app);

  registerNotificationRoutes(app);

  // ===== PURCHASING DASHBOARD ROUTES =====

  // GET /api/purchasing/dashboard
  app.get("/api/purchasing/dashboard", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;
      const data = await storage.getDashboardData(lookbackDays);
      res.json(data);
    } catch (error) {
      console.error("Error fetching purchasing dashboard:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // GET /api/purchasing/exclusion-rules
  app.get("/api/purchasing/exclusion-rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await storage.getReorderExclusionRules();
      const totalExcluded = await storage.getTotalExcludedProducts();

      // Get match counts for each rule
      const rulesWithCounts = await Promise.all(
        rules.map(async (r: any) => ({
          ...r,
          matchCount: await storage.getExclusionRuleMatchCount(r.field, r.value),
        }))
      );

      res.json({ rules: rulesWithCounts, totalExcluded });
    } catch (error) {
      console.error("Error fetching exclusion rules:", error);
      res.status(500).json({ error: "Failed to fetch exclusion rules" });
    }
  });

  // POST /api/purchasing/exclusion-rules
  app.post("/api/purchasing/exclusion-rules", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { field, value } = req.body;
      const validFields = ["category", "brand", "product_type", "sku_prefix", "sku_exact", "tag"];
      if (!field || !validFields.includes(field)) {
        return res.status(400).json({ error: `field must be one of: ${validFields.join(", ")}` });
      }
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        return res.status(400).json({ error: "value is required" });
      }

      const userId = (req as any).user?.id ?? req.session.user?.id;
      const rule = await storage.createReorderExclusionRule({
        field,
        value: value.trim(),
        createdBy: userId,
      });
      const matchCount = await storage.getExclusionRuleMatchCount(rule.field, rule.value);
      res.status(201).json({ ...rule, matchCount });
    } catch (error: any) {
      if (error?.message?.includes("unique") || error?.code === "23505") {
        return res.status(409).json({ error: "Rule already exists" });
      }
      console.error("Error creating exclusion rule:", error);
      res.status(500).json({ error: "Failed to create exclusion rule" });
    }
  });

  // DELETE /api/purchasing/exclusion-rules/:id
  app.delete("/api/purchasing/exclusion-rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReorderExclusionRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting exclusion rule:", error);
      res.status(500).json({ error: "Failed to delete exclusion rule" });
    }
  });

  // GET /api/purchasing/exclusion-rules/field-values?field=category
  // Returns distinct values for a given field from products table
  app.get("/api/purchasing/exclusion-rules/field-values", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { db } = await import("../../db");
      const field = String(req.query.field || "").trim();
      const allowedFields: Record<string, string | null> = {
        category: "category",
        brand: "brand",
        product_type: "product_type",
        tag: null, // handled separately — tags is jsonb array
      };
      if (!field || !(field in allowedFields)) {
        return res.status(400).json({ error: "Invalid field. Must be one of: category, brand, product_type, tag" });
      }
      let values: string[] = [];
      if (field === "tag") {
        // Unnest tags jsonb array
        const rows = await db.execute(sql`
          SELECT DISTINCT trim(tag::text, '"') AS value
          FROM catalog.products, jsonb_array_elements_text(tags) AS tag
          WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      } else {
        const col = allowedFields[field]!;
        const rows = await db.execute(sql`
          SELECT DISTINCT ${sql.raw(col)} AS value
          FROM catalog.products
          WHERE is_active = true AND ${sql.raw(col)} IS NOT NULL AND ${sql.raw(col)} != ''
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      }
      res.json({ field, values });
    } catch (error: any) {
      console.error("Error fetching field values:", error);
      res.status(500).json({ error: "Failed to fetch field values" });
    }
  });

  // PATCH /api/purchasing/products/:productId/reorder-excluded
  app.patch("/api/purchasing/products/:productId/reorder-excluded", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const { excluded } = req.body;
      if (typeof excluded !== "boolean") {
        return res.status(400).json({ error: "excluded must be a boolean" });
      }
      await storage.setProductReorderExcluded(productId, excluded);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error toggling product exclusion:", error);
      res.status(500).json({ error: "Failed to update product exclusion" });
    }
  });

  // GET /api/purchasing/auto-draft/status
  app.get("/api/purchasing/auto-draft/status", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const run = await storage.getLatestAutoDraftRun();
      res.json(run || null);
    } catch (error) {
      console.error("Error fetching auto-draft status:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft status" });
    }
  });

  // POST /api/purchasing/auto-draft/run
  app.post("/api/purchasing/auto-draft/run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const user = (req as any).user ?? req.session.user;
      if (user?.role !== "admin") {
        return res.status(403).json({ error: "Admin role required" });
      }

      // Import and run the job asynchronously
      const { runAutoDraftJob } = await import("../../jobs/auto-draft.job");
      runAutoDraftJob({ triggeredBy: "manual", triggeredByUser: user?.id })
        .catch((err: any) => console.error("[Auto-draft] manual run failed:", err));

      res.status(202).json({ message: "Auto-draft job started" });
    } catch (error) {
      console.error("Error triggering auto-draft:", error);
      res.status(500).json({ error: "Failed to trigger auto-draft" });
    }
  });

  // GET /api/purchasing/auto-draft-settings
  app.get("/api/purchasing/auto-draft-settings", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const settings = await storage.getAutoDraftSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching auto-draft settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // PATCH /api/purchasing/auto-draft-settings
  app.patch("/api/purchasing/auto-draft-settings", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { includeOrderSoon, skipOnOpenPo, skipNoVendor } = req.body;
      await storage.updateAutoDraftSettings(undefined, {
        includeOrderSoon,
        skipOnOpenPo,
        skipNoVendor,
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error updating auto-draft settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });
}
