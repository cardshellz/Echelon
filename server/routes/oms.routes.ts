import { requireAuth } from "./middleware";
/**
 * OMS API Routes
 *
 * Unified order management endpoints.
 */

import type { Express, Request, Response } from "express";
import type { OmsService } from "../modules/oms/oms.service";
import type { FulfillmentPushService } from "../modules/oms/fulfillment-push.service";
import type { ShipStationService } from "../modules/oms/shipstation.service";
import { db } from "../db";
import { getOmsOpsHealth } from "../modules/oms/ops-health.service";

export function registerOmsRoutes(app: Express) {
  const getOms = (req: Request): OmsService => (req.app.locals.services as any).oms;
  const getFulfillmentPush = (req: Request): FulfillmentPushService | null =>
    (req.app.locals.services as any).fulfillmentPush || null;
  const getShipStation = (req: Request): ShipStationService | null =>
    (req.app.locals.services as any).shipStation || null;

  // -----------------------------------------------------------------------
  // GET /api/oms/orders/stats — summary stats (must be before :id route)
  // -----------------------------------------------------------------------
  app.get("/api/oms/orders/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const stats = await getOms(req).getStats();
      res.json(stats);
    } catch (err: any) {
      console.error("[OMS Routes] Stats error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/oms/ops/health — OMS/WMS/Shipping exception visibility
  // -----------------------------------------------------------------------
  app.get("/api/oms/ops/health", requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json(await getOmsOpsHealth(db));
    } catch (err: any) {
      console.error("[OMS Routes] Ops health error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/oms/orders — list orders with filters
  // -----------------------------------------------------------------------
  app.get("/api/oms/orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const { channelId, status, search, startDate, endDate, page, limit } = req.query;

      const result = await getOms(req).listOrders({
        channelId: channelId ? Number(channelId) : undefined,
        status: status as string | undefined,
        search: search as string | undefined,
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 50,
      });

      res.json(result);
    } catch (err: any) {
      console.error("[OMS Routes] List orders error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/oms/orders/:id — order detail with lines and events
  // -----------------------------------------------------------------------
  app.get("/api/oms/orders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const order = await getOms(req).getOrderById(id);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      res.json(order);
    } catch (err: any) {
      console.error("[OMS Routes] Get order error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/oms/orders/:id/assign-warehouse — manual warehouse assignment
  // -----------------------------------------------------------------------
  app.post("/api/oms/orders/:id/assign-warehouse", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { warehouseId } = req.body;

      await getOms(req).assignWarehouse(id, warehouseId || 1);
      const order = await getOms(req).getOrderById(id);

      res.json(order);
    } catch (err: any) {
      console.error("[OMS Routes] Assign warehouse error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/oms/orders/:id/mark-shipped — manual ship with tracking
  // -----------------------------------------------------------------------
  app.post("/api/oms/orders/:id/mark-shipped", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { trackingNumber, carrier } = req.body;

      if (!trackingNumber || !carrier) {
        return res.status(400).json({ error: "trackingNumber and carrier are required" });
      }

      const order = await getOms(req).markShipped(id, trackingNumber, carrier);

      // Push tracking to channel
      const push = getFulfillmentPush(req);
      if (push) {
        try {
          await push.pushTracking(id);
        } catch (e: any) {
          console.error(`[OMS Routes] Tracking push failed for ${id}: ${e.message}`);
        }
      }

      const detail = await getOms(req).getOrderById(id);
      res.json(detail);
    } catch (err: any) {
      console.error("[OMS Routes] Mark shipped error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/oms/orders/:id/reserve — manual inventory reservation
  // -----------------------------------------------------------------------
  app.post("/api/oms/orders/:id/reserve", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const result = await getOms(req).reserveInventory(id);
      res.json(result);
    } catch (err: any) {
      console.error("[OMS Routes] Reserve error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/oms/orders/:id/push-to-shipstation — manual ShipStation push
  // -----------------------------------------------------------------------
  app.post("/api/oms/orders/:id/push-to-shipstation", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const ss = getShipStation(req);

      if (!ss || !ss.isConfigured()) {
        return res.status(503).json({ error: "ShipStation not configured" });
      }

      const order = await getOms(req).getOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const result = await ss.pushOrder(order);
      const updated = await getOms(req).getOrderById(id);

      res.json({
        shipstationOrderId: result.shipstationOrderId,
        orderKey: result.orderKey,
        order: updated,
      });
    } catch (err: any) {
      console.error("[OMS Routes] Push to ShipStation error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
