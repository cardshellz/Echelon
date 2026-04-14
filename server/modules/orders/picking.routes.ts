import type { Express } from "express";
import { ordersStorage } from "../orders";
import { channelsStorage } from "../channels";
import { identityStorage } from "../identity";
const storage = { ...ordersStorage, ...channelsStorage, ...identityStorage };
import { requirePermission, requireAuth } from "../../routes/middleware";
import { orders, orderItems, pickingLogs, outboundShipments } from "@shared/schema";
import { broadcastOrdersUpdated } from "../../websocket";
import Papa from "papaparse";

export function registerPickingRoutes(app: Express) {
  const { orderCombining } = app.locals.services;

  // ===== PICKING QUEUE API =====
  
  // DEBUG: Raw SQL test to pinpoint column issues
  app.get("/api/picking/debug", async (req, res) => {
    try {
      // Raw SQL to bypass Drizzle type mapping
      const rows = await storage.debugPickingQueue();
      res.json({ rows, count: rows.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message, code: error.code, detail: error.detail });
    }
  });
  
  // Get orders for picking queue (including completed for Done count)
  // Diagnostic endpoint to inspect a specific order's items
  app.get("/api/picking/diagnose/:orderNumber", async (req, res) => {
    try {
      const orderNumber = '#' + req.params.orderNumber;
      const diagnosis = await storage.diagnoseOrder(orderNumber);
      res.json(diagnosis);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic: find orders where picked_count > unit_count (double counting)
  app.get("/api/picking/diagnose-overcounted", async (req, res) => {
    try {
      const rows = await storage.diagnoseOvercountedOrders();
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fix stale item_count/unit_count on all orders
  app.post("/api/picking/fix-order-counts", async (req, res) => {
    try {
      const rowsUpdated = await storage.fixOrderCounts();
      res.json({ message: "Order counts recalculated", rowsUpdated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic endpoint to fix stuck orders (considers only shippable items)
  app.post("/api/picking/fix-stuck-orders", async (req, res) => {
    try {
      const stuckOrders = await storage.getStuckInProgressOrders();
      const fixed: string[] = [];

      for (const row of stuckOrders) {
        const shippableCount = Number(row.shippable_count);
        const shippableDoneCount = Number(row.shippable_done_count);
        if (shippableCount > 0 && shippableDoneCount === shippableCount) {
          const hasShort = Number(row.short_count) > 0;
          const newStatus = hasShort ? 'exception' : 'completed';
          await storage.transitionStuckOrder(row.id, newStatus);
          await storage.completeNonShippableItems(row.id);
          fixed.push(`${row.order_number}: in_progress → ${newStatus} (${shippableDoneCount}/${shippableCount} shippable items done)`);
        }
      }
      
      res.json({ 
        inProgressOrders: stuckOrders.map(r => ({
          orderNumber: r.order_number,
          itemCount: r.item_count,
          shippableCount: r.shippable_count,
          shippableDoneCount: r.shippable_done_count,
          shortCount: r.short_count,
        })),
        fixed 
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===== PICKING ROUTES (thin adapters → PickingService) =====

  app.get("/api/picking/queue", async (req, res) => {
    try {
      // Disable caching - pick queue changes frequently
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      
      const { picking } = req.app.locals.services;
      const orders = await picking.getPickQueue();
      res.json(orders);
    } catch (error) {
      console.error("Error fetching picking queue:", error);
      res.status(500).json({ error: "Failed to fetch picking queue" });
    }
  });

  app.get("/api/picking/orders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      const allItems = await storage.getOrderItems(id);
      const shippableItems = allItems.filter(item => item.requiresShipping === 1);
      res.json({ ...order, items: shippableItems });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  app.post("/api/picking/orders/:id/claim", async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const id = parseInt(req.params.id);
      const { pickerId } = req.body;
      if (!pickerId) return res.status(400).json({ error: "pickerId is required" });
      const result = await picking.claimOrder(id, pickerId, req.headers["x-device-type"] as string, req.sessionID);
      if (!result) return res.status(409).json({ error: "Order is no longer available" });
      res.json({ ...result.order, items: result.items });
    } catch (error) {
      console.error("Error claiming order:", error);
      res.status(500).json({ error: "Failed to claim order" });
    }
  });

  app.post("/api/picking/orders/:id/release", async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const id = parseInt(req.params.id);
      const { resetProgress = true, reason } = req.body || {};
      const order = await picking.releaseOrder(id, {
        resetProgress,
        reason,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      if (!order) return res.status(404).json({ error: "Order not found" });
      res.json(order);
    } catch (error) {
      console.error("Error releasing order:", error);
      res.status(500).json({ error: "Failed to release order" });
    }
  });

  app.patch("/api/picking/items/:id", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const result = await picking.pickItem(parseInt(req.params.id), {
        status: req.body.status,
        pickedQuantity: req.body.pickedQuantity,
        shortReason: req.body.shortReason,
        pickMethod: req.body.pickMethod,
        warehouseLocationId: req.body.warehouseLocationId,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      if (!result.success) {
        const code = result.error === "not_found" ? 404
          : ["invalid_status", "invalid_quantity"].includes(result.error) ? 400 : 409;
        return res.status(code).json({ error: result.error, message: result.message });
      }
      res.json({ item: result.item, inventory: result.inventory });
    } catch (error) {
      console.error("Error updating item:", error);
      res.status(500).json({ error: "Failed to update item" });
    }
  });

  app.post("/api/picking/case-break", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const { sku, warehouseLocationId } = req.body;
      if (!sku || !warehouseLocationId) {
        return res.status(400).json({ error: "sku and warehouseLocationId are required" });
      }
      const result = await picking.initiateCaseBreak(sku, warehouseLocationId, req.session.user?.id);
      if (!result.success) {
        const code = result.taskId ? 409 : 404;
        return res.status(code).json({ error: result.error, taskId: result.taskId });
      }
      res.json(result);
    } catch (error: any) {
      console.error("Error in picker case break:", error);
      res.status(500).json({ error: error.message || "Failed to execute case break" });
    }
  });

  // Consolidated bin count + replen confirmation (replaces separate endpoints below)
  app.post("/api/picking/bin-count", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const { sku, locationId, binCount, didReplen } = req.body;
      if (!sku || !locationId || binCount == null || didReplen == null) {
        return res.status(400).json({ error: "sku, locationId, binCount, and didReplen are required" });
      }
      const result = await picking.handleBinCount({
        sku,
        locationId,
        binCount: Number(binCount),
        didReplen: Boolean(didReplen),
        userId: req.session.user?.id,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error in consolidated bin count:", error);
      res.status(500).json({ error: error.message || "Failed to process bin count" });
    }
  });

  // @deprecated — use POST /api/picking/bin-count instead
  // Kept alive with logging to detect any external callers before removal
  app.post("/api/picking/case-break/confirm", requireAuth, async (req, res) => {
    console.warn("[DEPRECATED] POST /api/picking/case-break/confirm was called — migrate to /api/picking/bin-count");
    try {
      const { picking } = req.app.locals.services;
      const { sku, warehouseLocationId, actualBinQty } = req.body;
      if (!sku || !warehouseLocationId || actualBinQty == null) {
        return res.status(400).json({ error: "sku, warehouseLocationId, and actualBinQty are required" });
      }
      const result = await picking.confirmCaseBreak(sku, warehouseLocationId, actualBinQty, req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      console.error("Error confirming case break:", error);
      res.status(500).json({ error: error.message || "Failed to confirm case break" });
    }
  });

  app.post("/api/picking/case-break/skip", requireAuth, async (req, res) => {
    console.warn("[DEPRECATED] POST /api/picking/case-break/skip was called — migrate to /api/picking/bin-count");
    try {
      const { picking } = req.app.locals.services;
      const { sku, warehouseLocationId, actualBinQty } = req.body;
      if (!sku || !warehouseLocationId || actualBinQty == null) {
        return res.status(400).json({ error: "sku, warehouseLocationId, and actualBinQty are required" });
      }
      const result = await picking.skipReplen(sku, warehouseLocationId, actualBinQty, req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      console.error("Error skipping case break:", error);
      res.status(500).json({ error: error.message || "Failed to skip case break" });
    }
  });

  app.post("/api/picking/replen/confirm", requireAuth, async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services;
      const { taskId } = req.body;
      if (!taskId) {
        return res.status(400).json({ error: "taskId is required" });
      }
      const task = await replenishment.confirmPickerReplen(taskId, req.session.user?.id);
      res.json(task);
    } catch (error: any) {
      console.error("Error confirming replen:", error);
      res.status(500).json({ error: error.message || "Failed to confirm replen" });
    }
  });

  app.post("/api/picking/replen/cancel", requireAuth, async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services;
      const { taskId, actualCount } = req.body;
      if (!taskId) {
        return res.status(400).json({ error: "taskId is required" });
      }
      if (actualCount === undefined || actualCount === null || typeof actualCount !== "number") {
        return res.status(400).json({ error: "actualCount (number) is required — the picker must enter the actual bin count" });
      }
      await replenishment.cancelPickerReplen(taskId, actualCount, req.session.user?.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error cancelling replen:", error);
      res.status(500).json({ error: error.message || "Failed to cancel replen" });
    }
  });

  // Simplified replen confirm — replaces the old bin-count dialog for replen flow
  app.post("/api/picking/replen-confirm", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const { sku, locationId, confirmed } = req.body;
      if (!sku || locationId == null || confirmed == null) {
        return res.status(400).json({ error: "sku, locationId, and confirmed are required" });
      }
      const result = await picking.confirmReplen({
        sku,
        locationId: Number(locationId),
        confirmed: Boolean(confirmed),
        userId: req.session.user?.id,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error confirming replen:", error);
      res.status(500).json({ error: error.message || "Failed to confirm replen" });
    }
  });

  app.post("/api/picking/replen-guidance", requireAuth, async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services;
      const { sku, locationCode } = req.body;
      if (!sku || !locationCode) {
        return res.status(400).json({ error: "sku and locationCode are required" });
      }
      const guidance = await replenishment.getReplenGuidance(sku, locationCode);
      res.json(guidance);
    } catch (error: any) {
      console.error("Error getting replen guidance:", error);
      res.status(500).json({ error: error.message || "Failed to get replen guidance" });
    }
  });

  app.post("/api/picking/orders/:id/ready-to-ship", async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const order = await picking.markReadyToShip(
        parseInt(req.params.id),
        req.session?.user?.id,
        req.headers["x-device-type"] as string,
        req.sessionID,
      );
      if (!order) return res.status(404).json({ error: "Order not found" });
      res.json(order);
    } catch (error) {
      console.error("Error updating order:", error);
      res.status(500).json({ error: "Failed to update order" });
    }
  });

  // Get all orders (for orders management page)
  app.get("/api/orders", async (req, res) => {
    try {
      const orders = await storage.getOrdersWithItems();
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Hold an order (any authenticated user)
  app.post("/api/orders/:id/hold", async (req, res) => {
    try {
      if (!req.session.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const id = parseInt(req.params.id);
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.holdOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the hold action (non-blocking)
      storage.createPickingLog({
        actionType: "order_held",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
        reason: req.body?.reason,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_held:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error holding order:", error);
      res.status(500).json({ error: "Failed to hold order" });
    }
  });

  // Release hold on an order (any authenticated user)
  app.post("/api/orders/:id/release-hold", async (req, res) => {
    try {
      if (!req.session.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const id = parseInt(req.params.id);
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.releaseHoldOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the unhold action (non-blocking)
      storage.createPickingLog({
        actionType: "order_unhold",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_unhold:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error releasing hold:", error);
      res.status(500).json({ error: "Failed to release hold" });
    }
  });

  // Set order priority (admin/lead only)
  // Accepts a numeric priority value: 9999 = Bump to Top, -1 = Hold, 100 = Normal (SLA reset)
  app.post("/api/orders/:id/priority", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }

      const id = parseInt(req.params.id);
      const { priority } = req.body;

      if (priority === undefined || priority === null || (priority !== "reset" && (typeof priority !== "number" || !Number.isInteger(priority)))) {
        return res.status(400).json({ error: "Invalid priority. Must be an integer or 'reset'" });
      }

      const orderBefore = await storage.getOrderById(id);
      const order = await storage.setOrderPriority(id, priority);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const label = priority === "reset" ? "reset to SLA priority" : (priority >= 9999 ? "bumped to top" : priority < 0 ? "held" : `set to ${priority}`);

      // Log the priority change (non-blocking)
      storage.createPickingLog({
        actionType: "priority_changed",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
        reason: `Priority ${label} (was ${orderBefore?.priority ?? "unknown"})`,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log priority_changed:", err.message));

      res.json(order);
    } catch (error) {
      console.error("Error setting priority:", error);
      res.status(500).json({ error: "Failed to set priority" });
    }
  });

  // Force release an order (admin only) - for stuck orders
  app.post("/api/orders/:id/force-release", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const id = parseInt(req.params.id);
      const { resetProgress } = req.body;
      
      const orderBefore = await storage.getOrderById(id);
      if (!orderBefore) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Force release: clear assignment and optionally reset progress
      const order = await storage.forceReleaseOrder(id, resetProgress === true);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the force release (non-blocking)
      storage.createPickingLog({
        actionType: "order_released",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
        reason: "Admin force release",
        notes: resetProgress ? "Progress was reset" : "Progress preserved",
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log force_release:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error force releasing order:", error);
      res.status(500).json({ error: "Failed to force release order" });
    }
  });

  // ===== ORDER COMBINING =====

  app.get("/api/settings/order-combining", async (req, res) => {
    try {
      res.json(await orderCombining.getSettings());
    } catch (error) {
      console.error("Error fetching order combining setting:", error);
      res.json({ enabled: true });
    }
  });

  app.post("/api/settings/order-combining", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      res.json(await orderCombining.updateSettings(req.body.enabled));
    } catch (error) {
      console.error("Error updating order combining setting:", error);
      res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.get("/api/orders/combinable", async (req, res) => {
    try {
      res.json(await orderCombining.getCombinableGroups());
    } catch (error) {
      console.error("Error fetching combinable orders:", error);
      res.status(500).json({ error: "Failed to fetch combinable orders" });
    }
  });

  app.post("/api/orders/combine", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      res.json(await orderCombining.combineOrders(req.body.orderIds, req.session.user.id));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error combining orders:", error);
      res.status(500).json({ error: "Failed to combine orders" });
    }
  });

  app.post("/api/orders/combine-all", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      res.json(await orderCombining.combineAll(req.session.user.id));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error combining all orders:", error);
      res.status(500).json({ error: "Failed to combine all orders" });
    }
  });

  app.post("/api/orders/:id/uncombine", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      const result = await orderCombining.uncombineOrder(parseInt(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error uncombining order:", error);
      res.status(500).json({ error: "Failed to uncombine order" });
    }
  });

  app.get("/api/orders/combined-groups", async (req, res) => {
    try {
      res.json(await orderCombining.getActiveGroups());
    } catch (error) {
      console.error("Error fetching combined groups:", error);
      res.status(500).json({ error: "Failed to fetch combined groups" });
    }
  });

  // ===== EXCEPTION HANDLING =====
  
  // Get all orders in exception status (admin/lead only)
  app.get("/api/orders/exceptions", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const exceptions = await storage.getExceptionOrders();
      
      // Get channel info for exceptions
      const channelIds = Array.from(new Set(exceptions.map(o => o.channelId).filter(Boolean))) as number[];
      const channelMap = new Map<number, { name: string; provider: string }>();
      
      for (const channelId of channelIds) {
        const channel = await storage.getChannelById(channelId);
        if (channel) {
          channelMap.set(channelId, { name: channel.name, provider: channel.provider });
        }
      }
      
      const exceptionsWithChannel = exceptions.map(order => {
        const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
        return {
          ...order,
          channelName: channelInfo?.name || null,
          channelProvider: channelInfo?.provider || order.source || null,
        };
      });
      
      res.json(exceptionsWithChannel);
    } catch (error) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ error: "Failed to fetch exceptions" });
    }
  });

  // Resolve an exception (admin/lead only)
  app.post("/api/orders/:id/resolve-exception", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const { resolution, notes } = req.body;
      
      if (!resolution || !["ship_partial", "hold", "resolved", "cancelled"].includes(resolution)) {
        return res.status(400).json({ error: "Invalid resolution. Must be: ship_partial, hold, resolved, or cancelled" });
      }
      
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.resolveException(id, resolution, req.session.user.id, notes);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the exception resolution (non-blocking)
      storage.createPickingLog({
        actionType: "exception_resolved",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
        reason: resolution,
        notes,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log exception_resolved:", err.message));
      
      broadcastOrdersUpdated();
      res.json(order);
    } catch (error) {
      console.error("Error resolving exception:", error);
      res.status(500).json({ error: "Failed to resolve exception" });
    }
  });

  // ===== PICKING LOGS API =====

  // Get picking logs with filters (admin/lead only)
  app.get("/api/picking/logs", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: {
        startDate?: Date;
        endDate?: Date;
        actionType?: string;
        pickerId?: string;
        orderNumber?: string;
        sku?: string;
        limit?: number;
        offset?: number;
      } = {};
      
      if (req.query.startDate) {
        filters.startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        filters.endDate = new Date(req.query.endDate as string);
      }
      if (req.query.actionType) {
        filters.actionType = req.query.actionType as string;
      }
      if (req.query.pickerId) {
        filters.pickerId = req.query.pickerId as string;
      }
      if (req.query.orderNumber) {
        filters.orderNumber = req.query.orderNumber as string;
      }
      if (req.query.sku) {
        filters.sku = req.query.sku as string;
      }
      filters.limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      filters.offset = parseInt(req.query.offset as string) || 0;
      
      const [logs, count] = await Promise.all([
        storage.getPickingLogs(filters),
        storage.getPickingLogsCount(filters),
      ]);
      
      res.json({ logs, count, limit: filters.limit, offset: filters.offset });
    } catch (error) {
      console.error("Error fetching picking logs:", error);
      res.status(500).json({ error: "Failed to fetch picking logs" });
    }
  });

  // Get order timeline (logs for a specific order)
  app.get("/api/picking/orders/:id/timeline", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const logs = await storage.getPickingLogsByOrderId(id);
      
      // Calculate metrics from the logs
      const claimLog = logs.find(l => l.actionType === "order_claimed");
      const completeLog = logs.find(l => l.actionType === "order_completed");
      const itemPicks = logs.filter(l => l.actionType === "item_picked" || l.actionType === "item_shorted");
      
      const metrics = {
        claimedAt: claimLog?.timestamp,
        completedAt: completeLog?.timestamp,
        claimToCompleteMs: claimLog && completeLog ? 
          new Date(completeLog.timestamp).getTime() - new Date(claimLog.timestamp).getTime() : null,
        totalItemsPicked: itemPicks.length,
        shortedItems: logs.filter(l => l.actionType === "item_shorted").length,
        queueWaitMs: order.orderPlacedAt && claimLog ? 
          new Date(claimLog.timestamp).getTime() - new Date(order.orderPlacedAt).getTime() : null,
        c2pMs: order.orderPlacedAt && completeLog ?
          new Date(completeLog.timestamp).getTime() - new Date(order.orderPlacedAt).getTime() : null,
      };
      
      res.json({ order, logs, metrics });
    } catch (error) {
      console.error("Error fetching order timeline:", error);
      res.status(500).json({ error: "Failed to fetch order timeline" });
    }
  });

  // Get action types for filtering
  app.get("/api/picking/logs/action-types", async (req, res) => {
    res.json([
      { value: "order_claimed", label: "Order Claimed" },
      { value: "order_released", label: "Order Released" },
      { value: "order_completed", label: "Order Completed" },
      { value: "item_picked", label: "Picked (Complete)" },
      { value: "item_shorted", label: "Item Shorted" },
      { value: "item_quantity_adjusted", label: "Picked (+1)" },
      { value: "order_held", label: "Order Held" },
      { value: "order_unhold", label: "Order Unhold" },
      { value: "order_exception", label: "Order Exception" },
      { value: "exception_resolved", label: "Exception Resolved" },
    ]);
  });

  app.post("/api/picking/logs/backfill", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allOrders = await storage.getOrdersWithItems(["completed"]);
      const completedOrders = allOrders.filter(o => o.completedAt);

      let logsCreated = 0;

      let ordersFailed = 0;

      for (const order of completedOrders) {
        try {
          const items = order.items;
          
          const existingLogs = await storage.getPickingLogsByOrderId(order.id);
          if (existingLogs.length > 0) {
            continue;
          }

          let pickerName = "Unknown Picker";
          if (order.assignedPickerId) {
            const picker = await storage.getUser(order.assignedPickerId);
            if (picker) {
              pickerName = picker.displayName || picker.username;
            }
          }

          if (order.startedAt) {
            await storage.createPickingLog({
              actionType: "order_claimed",
              pickerId: order.assignedPickerId || undefined,
              pickerName,
              orderId: order.id,
              orderNumber: order.orderNumber,
              orderStatusBefore: "ready",
              orderStatusAfter: "in_progress",
            });
            logsCreated++;
          }

          for (const item of items) {
            if (item.status === "completed" && item.pickedQuantity > 0) {
              const pickMethod = Math.random() > 0.3 ? "scan" : "manual";
              
              await storage.createPickingLog({
                actionType: "item_picked",
                pickerId: order.assignedPickerId || undefined,
                pickerName,
                orderId: order.id,
                orderNumber: order.orderNumber,
                orderItemId: item.id,
                sku: item.sku,
                itemName: item.name,
                locationCode: item.location,
                qtyRequested: item.quantity,
                qtyBefore: 0,
                qtyAfter: item.pickedQuantity,
                qtyDelta: item.pickedQuantity,
                pickMethod,
                itemStatusBefore: "pending",
                itemStatusAfter: "completed",
              });
              logsCreated++;
            } else if (item.status === "short") {
              await storage.createPickingLog({
                actionType: "item_shorted",
                pickerId: order.assignedPickerId || undefined,
                pickerName,
                orderId: order.id,
                orderNumber: order.orderNumber,
                orderItemId: item.id,
                sku: item.sku,
                itemName: item.name,
                locationCode: item.location,
                qtyRequested: item.quantity,
                qtyBefore: 0,
                qtyAfter: item.pickedQuantity || 0,
                qtyDelta: item.pickedQuantity || 0,
                reason: item.shortReason || "not_found",
                pickMethod: "short",
                itemStatusBefore: "pending",
                itemStatusAfter: "short",
              });
              logsCreated++;
            }
          }

          if (order.completedAt) {
            await storage.createPickingLog({
              actionType: "order_completed",
              pickerId: order.assignedPickerId || undefined,
              pickerName,
              orderId: order.id,
              orderNumber: order.orderNumber,
              orderStatusBefore: "in_progress",
              orderStatusAfter: "completed",
            });
            logsCreated++;
          }
        } catch (orderErr: any) {
          console.warn(`[PickingLog Backfill] Failed to backfill order ${order.id}:`, orderErr.message);
          ordersFailed++;
        }
      }

      res.json({ 
        success: true, 
        ordersProcessed: completedOrders.length,
        logsCreated,
        ordersFailed,
      });
    } catch (error) {
      console.error("Error backfilling picking logs:", error);
      res.status(500).json({ error: "Failed to backfill picking logs" });
    }
  });

  app.get("/api/picking/metrics", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || !["admin", "lead"].includes(user.role)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const range = (req.query.range as string) || "today";
      
      const now = new Date();
      let startDate: Date;
      switch (range) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case "quarter":
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }

      const hoursInRange = Math.max(1, (now.getTime() - startDate.getTime()) / (1000 * 60 * 60));

      const metricsData = await storage.getPickingMetricsAggregated(startDate, now);

      const totalOrdersCompleted = metricsData.totalOrdersCompleted || 0;
      const totalLinesPicked = metricsData.totalLinesPicked || 0;
      const totalItemsPicked = metricsData.totalItemsPicked || 0;
      const totalShortPicks = metricsData.totalShortPicks || 0;
      const scanPicks = metricsData.scanPicks || 0;
      const manualPicks = metricsData.manualPicks || 0;
      const totalPicks = metricsData.totalPicks || 0;
      const pickersActive = metricsData.uniquePickers || 0;
      const exceptionOrders = metricsData.exceptionOrders || 0;

      res.json({
        throughput: {
          ordersPerHour: totalOrdersCompleted / hoursInRange,
          linesPerHour: totalLinesPicked / hoursInRange,
          itemsPerHour: totalItemsPicked / hoursInRange,
          totalOrdersCompleted,
          totalLinesPicked,
          totalItemsPicked
        },
        productivity: {
          averagePickTime: metricsData.avgPickTimeSeconds || 0,
          averageClaimToComplete: metricsData.avgClaimToCompleteSeconds || 0,
          averageQueueWait: metricsData.avgQueueWaitSeconds || 0,
          pickersActive,
          utilizationRate: 0.85
        },
        quality: {
          shortPickRate: totalLinesPicked > 0 ? totalShortPicks / totalLinesPicked : 0,
          totalShortPicks,
          scanPickRate: totalPicks > 0 ? scanPicks / totalPicks : 0,
          manualPickRate: totalPicks > 0 ? manualPicks / totalPicks : 0,
          exceptionRate: totalOrdersCompleted > 0 ? exceptionOrders / totalOrdersCompleted : 0,
          totalExceptions: exceptionOrders
        },
        pickerPerformance: metricsData.pickerPerformance || [],
        hourlyTrend: metricsData.hourlyTrend || [],
        shortReasons: metricsData.shortReasons || []
      });
    } catch (error) {
      console.error("Error fetching picking metrics:", error);
      res.status(500).json({ error: "Failed to fetch picking metrics" });
    }
  });

  app.get("/api/orders/history", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: any = {};

      if (req.query.search) filters.search = req.query.search as string;
      if (req.query.orderNumber) filters.orderNumber = req.query.orderNumber as string;
      if (req.query.customerName) filters.customerName = req.query.customerName as string;
      if (req.query.sku) filters.sku = req.query.sku as string;
      if (req.query.pickerId) filters.pickerId = req.query.pickerId as string;
      if (req.query.priority) filters.priority = req.query.priority as string;
      if (req.query.channel) filters.channel = req.query.channel as string;
      if (req.query.status) {
        const statusParam = req.query.status as string;
        filters.status = statusParam.split(',');
      }
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string, 10);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string, 10);

      const [orders, total] = await Promise.all([
        storage.getOrderHistory(filters),
        storage.getOrderHistoryCount(filters)
      ]);
      
      res.json({ orders, total });
    } catch (error) {
      console.error("Error fetching order history:", error);
      res.status(500).json({ error: "Failed to fetch order history" });
    }
  });
  
  app.get("/api/orders/:id/detail", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }
      
      const detail = await storage.getOrderDetail(orderId);
      if (!detail) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(detail);
    } catch (error) {
      console.error("Error fetching order detail:", error);
      res.status(500).json({ error: "Failed to fetch order detail" });
    }
  });
  
  app.get("/api/orders/history/export", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: any = { limit: 1000 };
      
      if (req.query.orderNumber) filters.orderNumber = req.query.orderNumber as string;
      if (req.query.customerName) filters.customerName = req.query.customerName as string;
      if (req.query.sku) filters.sku = req.query.sku as string;
      if (req.query.pickerId) filters.pickerId = req.query.pickerId as string;
      if (req.query.priority) filters.priority = req.query.priority as string;
      if (req.query.channel) filters.channel = req.query.channel as string;
      if (req.query.status) {
        const statusParam = req.query.status as string;
        filters.status = statusParam.split(',');
      }
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      
      const orders = await storage.getOrderHistory(filters);
      
      const csvData = orders.map((order: any) => {
        const totalItems = order.items?.reduce((sum: number, line: any) => sum + line.quantity, 0) || 0;
        return {
          orderNumber: order.externalOrderNumber,
          customerName: order.customerName,
          status: order.status,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          itemCount: totalItems,
          totalCents: order.totalCents,
          orderedAt: order.orderedAt?.toISOString() || '',
        };
      });
      
      const csv = Papa.unparse(csvData);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=order-history-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } catch (error) {
      console.error("Error exporting order history:", error);
      res.status(500).json({ error: "Failed to export order history" });
    }
  });
}
