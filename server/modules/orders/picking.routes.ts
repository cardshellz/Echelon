import type { Express } from "express";
import { ordersStorage } from "../orders";
import { channelsStorage } from "../channels";
import { identityStorage } from "../identity";
const storage = { ...ordersStorage, ...channelsStorage, ...identityStorage };
import { requirePermission, requireAuth } from "../../routes/middleware";
import { orders, orderItems, pickingLogs, outboundShipments } from "@shared/schema";
import { broadcastOrdersUpdated } from "../../websocket";
import { db } from "../../db";
import {
  enqueueShipStationHoldSyncRetry,
  enqueueShipStationSortRankSyncRetry,
  enqueueShipStationShipmentPushRetry,
} from "../oms/webhook-retry.worker";
import { engineRefFromRow } from "../shipping/adapters/shipstation.adapter";
import { sql } from "drizzle-orm";
import Papa from "papaparse";

export function registerPickingRoutes(app: Express) {
  const { orderCombining } = app.locals.services;
  const pickerReplenAuthorityRemoved = (res: any) => res.status(410).json({
    error: "Picker replen confirmation has been removed",
    message: "Replenishment is system-owned. Use replenishment/admin workflows for task execution or cancellation; picker input is limited to pick exceptions and QA review signals.",
  });
  const queueShipStationHoldSync = async (
    orderId: number,
    mode: "hold" | "release",
    context: string,
  ) => {
    await enqueueShipStationHoldSyncRetry(db, orderId, mode, context);

    const { shippingEngine } = app.locals.services || {} as any;
    if (!shippingEngine?.isConfigured?.()) return;

    void (async () => {
      const rows = await db.execute(sql`
        SELECT shipping_engine, engine_order_ref, engine_shipment_ref,
               shipstation_order_id, shipstation_order_key
        FROM wms.outbound_shipments
        WHERE order_id = ${orderId}
          AND COALESCE(engine_order_ref, shipstation_order_id::text) IS NOT NULL
          AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
        ORDER BY id
      `);
      for (const row of rows.rows ?? []) {
        const ref = engineRefFromRow(row as any);
        if (!ref) continue;
        try {
          if (mode === "hold") {
            await shippingEngine.hold(ref);
          } else {
            await shippingEngine.releaseHold(ref);
          }
        } catch (err: any) {
          console.warn(`[${context}] engine ${mode} failed for ref ${ref.engineOrderRef}: ${err?.message}`);
        }
      }
    })().catch((err: any) => {
      console.warn(
        `[${context}] immediate engine ${mode} sync failed for order ${orderId}; retry queued:`,
        err?.message ?? err,
      );
    });
  };
  const queueShipStationSortRankSync = async (
    orderId: number,
    context: string,
  ) => {
    await enqueueShipStationSortRankSyncRetry(db, orderId, context);

    const { shippingEngine } = app.locals.services || {} as any;
    if (!shippingEngine?.isConfigured?.()) return;

    void (async () => {
      const [order] = await db.select({ sortRank: orders.sortRank })
        .from(orders).where(sql`${orders.id} = ${orderId}`).limit(1);
      if (!order?.sortRank) return;

      const rows = await db.execute(sql`
        SELECT shipping_engine, engine_order_ref, engine_shipment_ref,
               shipstation_order_id, shipstation_order_key
        FROM wms.outbound_shipments
        WHERE order_id = ${orderId}
          AND COALESCE(engine_order_ref, shipstation_order_id::text) IS NOT NULL
          AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
        ORDER BY id
      `);
      for (const row of rows.rows ?? []) {
        const ref = engineRefFromRow(row as any);
        if (!ref) continue;
        try {
          await shippingEngine.updatePriority(ref, order.sortRank);
        } catch (err: any) {
          console.warn(`[${context}] engine updatePriority failed for ref ${ref.engineOrderRef}: ${err?.message}`);
        }
      }
    })().catch((err: any) => {
      console.warn(
        `[${context}] immediate engine sort-rank sync failed for order ${orderId}; retry queued:`,
        err?.message ?? err,
      );
    });
  };

  // ===== PICKING QUEUE API =====
  
  // DEBUG: Raw SQL test to pinpoint column issues
  app.get("/api/picking/debug", requireAuth, async (req, res) => {
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
  app.get("/api/picking/diagnose/:orderNumber", requireAuth, async (req, res) => {
    try {
      const orderNumber = '#' + req.params.orderNumber;
      const diagnosis = await storage.diagnoseOrder(orderNumber);
      res.json(diagnosis);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic: find orders where picked_count > unit_count (double counting)
  app.get("/api/picking/diagnose-overcounted", requireAuth, async (req, res) => {
    try {
      const rows = await storage.diagnoseOvercountedOrders();
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fix stale item_count/unit_count on all orders
  app.post("/api/picking/fix-order-counts", requireAuth, async (req, res) => {
    try {
      const rowsUpdated = await storage.fixOrderCounts();
      res.json({ message: "Order counts recalculated", rowsUpdated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic endpoint to fix stuck orders (considers only shippable items)
  app.post("/api/picking/fix-stuck-orders", requireAuth, async (req, res) => {
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

  app.get("/api/picking/queue", requireAuth, async (req, res) => {
    try {
      // Disable caching - pick queue changes frequently
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      
      const { picking } = req.app.locals.services;
      const orders = await picking.getPickQueue();
      res.json(orders);
    } catch (error: any) {
      console.error("Error fetching picking queue:", error);
      res.status(500).json({ error: "Failed to fetch picking queue" });
    }
  });

  app.get("/api/picking/orders/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      const allItems = await storage.getOrderItems(id);
      const shippableItems = allItems.filter(item => item.requiresShipping === 1);
      res.json({ ...order, items: shippableItems });
    } catch (error: any) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  app.post("/api/picking/orders/:id/claim", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const id = parseInt(req.params.id);
      const pickerId = req.session.user?.id;
      if (!pickerId) return res.status(401).json({ error: "Authentication required" });
      const rawClaimSource = typeof req.body?.claimSource === "string" ? req.body.claimSource : undefined;
      const claimSource = rawClaimSource?.slice(0, 64);
      const result = await picking.claimOrder(
        id,
        pickerId,
        req.headers["x-device-type"] as string,
        req.sessionID,
        claimSource,
      );

      res.json({ ...result.order, items: result.items });
    } catch (error: any) {
      console.error("Error claiming order:", error);
      // Surface structured claim failures (on hold / actively picked by another
      // picker / not claimable) with their real status code + reason so the UI
      // can show the truth instead of a blanket "claimed by another picker".
      if (error?.isOperational && typeof error.statusCode === "number") {
        return res.status(error.statusCode).json({
          error: error.message,
          reason: error.context?.reason,
          context: error.context,
        });
      }
      res.status(500).json({ error: "Failed to claim order" });
    }
  });

  app.post("/api/picking/orders/:id/release", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const id = parseInt(req.params.id);
      const { resetProgress = false, reason } = req.body || {};
      if (resetProgress === true) {
        return res.status(400).json({
          error: "Picker release cannot reset pick progress; use admin repair reset",
          reason: "reset_not_allowed_on_release",
        });
      }
      const order = await picking.releaseOrder(id, {
        resetProgress: false,
        reason,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      if (!order) return res.status(404).json({ error: "Order not found" });
      res.json(order);
    } catch (error: any) {
      console.error("Error releasing order:", error);
      const status = error?.isOperational && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
      res.status(status).json({ error: error.message || "Failed to release order" });
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
        return res.status(400).json(result);
      }
      
      res.json({ item: result.item, inventory: result.inventory });
    } catch (error: any) {
      console.error("Error updating item:", error);
      const status = error?.isOperational && typeof error.statusCode === "number"
        ? error.statusCode
        : error?.name === "ValidationError" ? 400 : 500;
      res.status(status).json({ error: error.message || "Failed to update item" });
    }
  });

  app.post("/api/picking/items/:id/unpick", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const result = await picking.unpickItem(parseInt(req.params.id), {
        qty: req.body.qty,
        reason: req.body.reason,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });

      if (!result.success) {
        return res.status(409).json(result);
      }

      res.json({ item: result.item, inventory: result.inventory });
    } catch (error: any) {
      console.error("Error unpicking item:", error);
      const status = error?.isOperational && typeof error.statusCode === "number"
        ? error.statusCode
        : error?.name === "ValidationError" ? 400 : 500;
      res.status(status).json({ error: error.message || "Failed to unpick item" });
    }
  });

  app.post("/api/picking/items/:id/resolve-allocation", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const locationCode = req.body.locationCode ?? req.body.binCode ?? req.body.scanCode;
      const warehouseLocationId = req.body.warehouseLocationId == null ? undefined : Number(req.body.warehouseLocationId);
      if (!locationCode && !warehouseLocationId) {
        return res.status(400).json({ error: "locationCode or warehouseLocationId is required" });
      }

      const result = await picking.resolveAllocationWithBin(parseInt(req.params.id), {
        locationCode,
        warehouseLocationId,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });

      if (!result.success) {
        return res.status(409).json(result);
      }

      res.json(result);
    } catch (error: any) {
      console.error("Error resolving allocation:", error);
      const status = error?.name === "ValidationError" ? 400 : 500;
      res.status(status).json({ error: error.message || "Failed to resolve allocation" });
    }
  });

  app.post("/api/picking/items/:id/replen-source-empty", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services;
      const result = await picking.reportReplenSourceEmpty(parseInt(req.params.id), {
        sourceLocationCode: req.body?.sourceLocationCode ?? null,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error reporting replen source empty:", error);
      const status = error?.name === "ValidationError" ? 400 : 500;
      res.status(status).json({ error: error.message || "Failed to report replen source empty" });
    }
  });

  app.post("/api/picking/case-break", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));

  // Consolidated picker bin count. Replen execution remains system-owned.
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

  app.post("/api/picking/case-break/confirm", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));
  app.post("/api/picking/case-break/skip", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));
  app.post("/api/picking/replen/confirm", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));
  app.post("/api/picking/replen/cancel", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));
  app.post("/api/picking/replen-confirm", requireAuth, async (_req, res) => pickerReplenAuthorityRemoved(res));

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

  app.post("/api/picking/orders/:id/ready-to-ship", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error updating order:", error);
      const status = error?.name === "ValidationError" ? 409 : 500;
      res.status(status).json({ error: error.message || "Failed to update order" });
    }
  });

  // Get all orders (for orders management page)
  app.get("/api/orders", requireAuth, async (req, res) => {
    try {
      const orders = await storage.getOrdersWithItems();
      res.json(orders);
    } catch (error: any) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Hold an order (any authenticated user)
  app.post("/api/orders/:id/hold", requireAuth, async (req, res) => {
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

      // Local WMS state is authoritative; ShipStation sync is retried durably.
      await queueShipStationHoldSync(id, "hold", "Hold");
      await queueShipStationSortRankSync(id, "HoldSortRank");
      
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
    } catch (error: any) {
      console.error("Error holding order:", error);
      res.status(500).json({ error: "Failed to hold order" });
    }
  });

  // Release hold on an order (any authenticated user)
  app.post("/api/orders/:id/release-hold", requireAuth, async (req, res) => {
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

      // Local WMS state is authoritative; ShipStation sync is retried durably.
      await queueShipStationHoldSync(id, "release", "ReleaseHold");
      await queueShipStationSortRankSync(id, "ReleaseHoldSortRank");
      
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
    } catch (error: any) {
      console.error("Error releasing hold:", error);
      res.status(500).json({ error: "Failed to release hold" });
    }
  });

  // Hold a single LINE ITEM — gated by orders:hold (picker role lacks it).
  // P1 of line-item hold (LINE-ITEM-HOLD-DESIGN.md): records the hold + reason so
  // the line can be withheld while the rest of the order ships. The held line is
  // not yet pulled from the ShipStation push — that behaviour is P2.
  app.post(
    "/api/orders/:id/items/:itemId/hold",
    requireAuth,
    requirePermission("orders", "hold"),
    async (req, res) => {
      try {
        if (!req.session.user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const orderId = parseInt(req.params.id);
        const itemId = parseInt(req.params.itemId);
        const reason =
          typeof req.body?.reason === "string" && req.body.reason.trim()
            ? req.body.reason.trim()
            : "manual_hold";

        const item = await storage.getOrderItemById(itemId);
        if (!item || item.orderId !== orderId) {
          return res.status(404).json({ error: "Line item not found on this order" });
        }
        // Only a line that has not started picking/fulfillment can be held; once
        // it is in motion, holding it would strand a picked/shipped unit.
        if (
          item.status !== "pending" ||
          (item.pickedQuantity ?? 0) > 0 ||
          (item.fulfilledQuantity ?? 0) > 0
        ) {
          return res.status(409).json({
            error: "Line has already started picking or fulfillment and cannot be held",
            status: item.status,
          });
        }

        // P2a (LINE-ITEM-HOLD-DESIGN.md): mark held + split the line into its own
        // held shipment in one transaction, then re-push the main shipment WITHOUT
        // the held line if it was already in ShipStation.
        const { holdLineItemWithSplit } = await import("../wms/line-item-hold");
        const split = await holdLineItemWithSplit(db, {
          wmsOrderId: orderId,
          orderItemId: itemId,
          reason,
          now: new Date(),
        });
        if (split.mainShipmentPushed && split.mainStillHasItems && split.mainShipmentId) {
          await enqueueShipStationShipmentPushRetry(db, split.mainShipmentId, "LineItemHeldRepushMain")
            .catch((e: any) => console.warn("[line-item-hold] main re-push enqueue failed:", e?.message));
        }

        const order = await storage.getOrderById(orderId);
        storage
          .createPickingLog({
            actionType: "line_item_held",
            pickerId: req.session.user.id,
            pickerName: req.session.user.displayName || req.session.user.username,
            pickerRole: req.session.user.role,
            orderId,
            orderNumber: order?.orderNumber,
            reason,
            notes: `SKU ${item.sku} -> held shipment ${split.heldShipmentId ?? "?"}`,
            deviceType: (req.headers["x-device-type"] as string) || "desktop",
            sessionId: req.sessionID,
          })
          .catch((err) => console.warn("[PickingLog] Failed to log line_item_held:", err.message));

        broadcastOrdersUpdated();
        res.json({ ok: true, heldShipmentId: split.heldShipmentId });
      } catch (error: any) {
        console.error("Error holding line item:", error);
        res.status(500).json({ error: "Failed to hold line item" });
      }
    },
  );

  // Release a single LINE ITEM hold — gated by orders:hold.
  app.post(
    "/api/orders/:id/items/:itemId/release-hold",
    requireAuth,
    requirePermission("orders", "hold"),
    async (req, res) => {
      try {
        if (!req.session.user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const orderId = parseInt(req.params.id);
        const itemId = parseInt(req.params.itemId);

        const item = await storage.getOrderItemById(itemId);
        if (!item || item.orderId !== orderId) {
          return res.status(404).json({ error: "Line item not found on this order" });
        }

        // P2a: clear the line hold + un-hold its shipment in one transaction, then
        // push that shipment so the released line ships on its own.
        const { releaseLineItemFromHold } = await import("../wms/line-item-hold");
        const released = await releaseLineItemFromHold(db, {
          wmsOrderId: orderId,
          orderItemId: itemId,
          now: new Date(),
        });
        if (released.heldShipmentId) {
          await enqueueShipStationShipmentPushRetry(db, released.heldShipmentId, "LineItemReleasedPush")
            .catch((e: any) => console.warn("[line-item-hold] released push enqueue failed:", e?.message));
        }

        const order = await storage.getOrderById(orderId);
        storage
          .createPickingLog({
            actionType: "line_item_released",
            pickerId: req.session.user.id,
            pickerName: req.session.user.displayName || req.session.user.username,
            pickerRole: req.session.user.role,
            orderId,
            orderNumber: order?.orderNumber,
            notes: `SKU ${item.sku} -> shipment ${released.heldShipmentId ?? "?"}`,
            deviceType: (req.headers["x-device-type"] as string) || "desktop",
            sessionId: req.sessionID,
          })
          .catch((err) => console.warn("[PickingLog] Failed to log line_item_released:", err.message));

        broadcastOrdersUpdated();
        res.json({ ok: true, heldShipmentId: released.heldShipmentId });
      } catch (error: any) {
        console.error("Error releasing line item hold:", error);
        res.status(500).json({ error: "Failed to release line item hold" });
      }
    },
  );

  // Set order priority (admin/lead only)
  // Accepts a numeric priority value: 9999 = Bump to Top, -1 = Hold, 100 = Normal (SLA reset)
  app.post("/api/orders/:id/priority", requireAuth, async (req, res) => {
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

      // Local WMS sort_rank is authoritative; ShipStation customField1 sync is retried durably.
      await queueShipStationSortRankSync(id, "PrioritySortRank");

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
    } catch (error: any) {
      console.error("Error setting priority:", error);
      res.status(500).json({ error: "Failed to set priority" });
    }
  });

  // Force release an order (admin only) - for stuck orders
  app.post("/api/orders/:id/force-release", requireAuth, async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const id = parseInt(req.params.id);
      const { resetProgress, reason } = req.body || {};
      const resetRequested = resetProgress === true;
      
      const orderBefore = await storage.getOrderById(id);
      if (!orderBefore) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (resetRequested) {
        const resetReason = typeof reason === "string" ? reason.trim() : "";
        if (!resetReason) {
          return res.status(400).json({
            error: "Admin reset requires a reason",
            reason: "reset_reason_required",
          });
        }

        const items = await storage.getOrderItems(id);
        const pickedItem = items.find(item => (item.pickedQuantity || 0) > 0);
        if (pickedItem) {
          return res.status(409).json({
            error: "Cannot reset pick progress after picking has started; use the explicit unpick workflow",
            reason: "reset_blocked_after_pick",
            orderItemId: pickedItem.id,
            pickedQuantity: pickedItem.pickedQuantity,
          });
        }
      }
      
      // Force release: clear assignment and optionally reset progress
      const order = await storage.forceReleaseOrder(id, resetRequested);
      
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
        reason: resetRequested ? reason.trim() : "Admin force release",
        notes: resetRequested ? "Progress was reset" : "Progress preserved",
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log force_release:", err.message));
      
      res.json(order);
    } catch (error: any) {
      console.error("Error force releasing order:", error);
      const status = error?.isOperational && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
      res.status(status).json({ error: error.message || "Failed to force release order" });
    }
  });

  // ===== ORDER COMBINING =====

  app.get("/api/settings/order-combining", requireAuth, async (req, res) => {
    try {
      // Optional ?warehouseId=X — if omitted, returns the DEFAULT template value
      const raw = req.query.warehouseId;
      const warehouseId =
        typeof raw === "string" && raw.trim().length > 0
          ? Number.parseInt(raw, 10)
          : null;
      const effective = Number.isFinite(warehouseId as number) ? (warehouseId as number) : null;
      res.json(await orderCombining.getSettings(effective));
    } catch (error: any) {
      console.error("Error fetching order combining setting:", error);
      res.json({ enabled: true });
    }
  });

  app.post("/api/settings/order-combining", requireAuth, async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      // Body: { warehouseId: number | null, enabled: boolean }
      // warehouseId omitted / null → writes the DEFAULT template.
      const warehouseId =
        typeof req.body.warehouseId === "number" ? req.body.warehouseId : null;
      const enabled = !!req.body.enabled;
      res.json(await orderCombining.updateSettings(warehouseId, enabled));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error updating order combining setting:", error);
      res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.get("/api/orders/combinable", requireAuth, async (req, res) => {
    try {
      // Optional ?warehouseId=X — scopes the search to one warehouse
      const raw = req.query.warehouseId;
      const warehouseId =
        typeof raw === "string" && raw.trim().length > 0
          ? Number.parseInt(raw, 10)
          : null;
      const effective = Number.isFinite(warehouseId as number) ? (warehouseId as number) : null;
      res.json(await orderCombining.getCombinableGroups(effective));
    } catch (error: any) {
      console.error("Error fetching combinable orders:", error);
      res.status(500).json({ error: "Failed to fetch combinable orders" });
    }
  });

  app.post("/api/orders/combine", requireAuth, async (req, res) => {
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

  app.post("/api/orders/combine-all", requireAuth, async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      // Optional body.warehouseId — scopes the sweep to a single warehouse
      const warehouseId =
        typeof req.body?.warehouseId === "number" ? req.body.warehouseId : null;
      res.json(await orderCombining.combineAll(req.session.user.id, warehouseId));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error combining all orders:", error);
      res.status(500).json({ error: "Failed to combine all orders" });
    }
  });

  app.post("/api/orders/:id/uncombine", requireAuth, async (req, res) => {
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

  app.get("/api/orders/combined-groups", requireAuth, async (req, res) => {
    try {
      res.json(await orderCombining.getActiveGroups());
    } catch (error: any) {
      console.error("Error fetching combined groups:", error);
      res.status(500).json({ error: "Failed to fetch combined groups" });
    }
  });

  // ===== EXCEPTION HANDLING =====
  
  // Get all orders in exception status (admin/lead only)
  app.get("/api/orders/exceptions", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ error: "Failed to fetch exceptions" });
    }
  });

  // Resolve an exception (admin/lead only)
  app.post("/api/orders/:id/resolve-exception", requireAuth, async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      const { picking } = req.app.locals.services;
      
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

      const closedBlockers = await picking.closeResolvedShipmentBlockers(id, {
        resolution,
        userId: req.session.user.id,
        notes,
      });
      
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
        notes: [
          notes,
          closedBlockers.allocationExceptionsClosed || closedBlockers.replenTasksClosed
            ? `Closed shipment blockers: allocation=${closedBlockers.allocationExceptionsClosed}, replen=${closedBlockers.replenTasksClosed}`
            : null,
        ].filter(Boolean).join("\n") || undefined,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log exception_resolved:", err.message));
      
      broadcastOrdersUpdated();
      res.json({ ...order, closedBlockers });
    } catch (error: any) {
      console.error("Error resolving exception:", error);
      res.status(500).json({ error: "Failed to resolve exception" });
    }
  });

  // ===== PICKING LOGS API =====

  // Get picking logs with filters (admin/lead only)
  app.get("/api/picking/logs", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching picking logs:", error);
      res.status(500).json({ error: "Failed to fetch picking logs" });
    }
  });

  // Get order timeline (logs for a specific order)
  app.get("/api/picking/orders/:id/timeline", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching order timeline:", error);
      res.status(500).json({ error: "Failed to fetch order timeline" });
    }
  });

  // Get action types for filtering
  app.get("/api/picking/logs/action-types", requireAuth, async (req, res) => {
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

  app.post("/api/picking/logs/backfill", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error backfilling picking logs:", error);
      res.status(500).json({ error: "Failed to backfill picking logs" });
    }
  });

  app.get("/api/picking/metrics", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching picking metrics:", error);
      res.status(500).json({ error: "Failed to fetch picking metrics" });
    }
  });

  app.get("/api/orders/history", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching order history:", error);
      res.status(500).json({ error: "Failed to fetch order history" });
    }
  });
  
  app.get("/api/orders/:id/detail", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error fetching order detail:", error);
      res.status(500).json({ error: "Failed to fetch order detail" });
    }
  });
  
  app.get("/api/orders/history/export", requireAuth, async (req, res) => {
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
    } catch (error: any) {
      console.error("Error exporting order history:", error);
      res.status(500).json({ error: "Failed to export order history" });
    }
  });
}
