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
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getOmsOpsHealth } from "../modules/oms/ops-health.service";
import { remediateOmsFlowIssue } from "../modules/oms/oms-flow-reconciliation.service";
import { enqueueWebhookInboxReplay } from "../modules/oms/webhook-inbox.service";
import { requeueDeadWebhookRetry } from "../modules/oms/webhook-retry.worker";

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

  app.post("/api/oms/ops/webhook-inbox/:id/replay", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const operator =
        req.session.user?.username ||
        req.session.user?.displayName ||
        String(req.session.user?.id || "unknown");
      const result = await enqueueWebhookInboxReplay(db, id, operator);
      res.json(result);
    } catch (err: any) {
      console.error("[OMS Routes] Webhook inbox replay error:", err);
      const message = err?.message || "Failed to queue webhook replay";
      const status = /positive integer/i.test(message)
        ? 400
        : /not found/i.test(message)
          ? 404
          : /already succeeded|not a replayable/i.test(message)
            ? 409
            : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/oms/ops/webhook-retry/:id/requeue", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const operator =
        req.session.user?.username ||
        req.session.user?.displayName ||
        String(req.session.user?.id || "unknown");
      const result = await requeueDeadWebhookRetry(db, id, operator);
      res.json(result);
    } catch (err: any) {
      console.error("[OMS Routes] Webhook retry requeue error:", err);
      const message = err?.message || "Failed to requeue webhook retry";
      const status = /positive integer/i.test(message)
        ? 400
        : /not found/i.test(message)
          ? 404
          : /not dead-lettered/i.test(message)
            ? 409
            : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/oms/ops/reconciliation/remediate", requireAuth, async (req: Request, res: Response) => {
    try {
      const operator =
        req.session.user?.username ||
        req.session.user?.displayName ||
        String(req.session.user?.id || "unknown");
      const result = await remediateOmsFlowIssue(db, {
        code: String(req.body?.code || ""),
        omsOrderId: req.body?.omsOrderId,
        wmsOrderId: req.body?.wmsOrderId,
        shipmentId: req.body?.shipmentId,
        operator,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[OMS Routes] Reconciliation remediation error:", err);
      const message = err?.message || "Failed to remediate OMS flow issue";
      const status = /positive integer/i.test(message)
        ? 400
        : /unsupported/i.test(message)
          ? 409
          : 500;
      res.status(status).json({ error: message });
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
  // POST /api/oms/shipments/:id/push — manual WMS shipment push to engine
  // -----------------------------------------------------------------------
  app.post("/api/oms/shipments/:id/push", requireAuth, async (req: Request, res: Response) => {
    try {
      const shipmentId = Number(req.params.id);
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        return res.status(400).json({ error: "Invalid shipment ID" });
      }
      const ss = getShipStation(req);
      if (!ss || !ss.isConfigured()) {
        return res.status(503).json({ error: "ShipStation not configured" });
      }
      const result = await ss.pushShipment(shipmentId);
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[OMS Routes] Push shipment error:", err);
      res.status(err.httpStatus || 500).json({ error: err.message, code: err.code });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/oms/orders/:id/push-to-shipstation — manual ShipStation push
  //
  // RETIRED legacy path: this used to call the OMS-level pushOrder, which
  // created a ShipStation order keyed `echelon-oms-<omsOrderId>` — a DIFFERENT key
  // than the canonical WMS shipment push (`echelon-wms-shp-<shipmentId>`).
  // Because ShipStation dedups on orderKey, an order could end up duplicated
  // in ShipStation (one SS order per path). We now delegate to the single
  // canonical shipment push so there is exactly one SS order per shipment.
  // -----------------------------------------------------------------------
  app.post("/api/oms/orders/:id/push-to-shipstation", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid order ID" });
      }
      const ss = getShipStation(req);

      if (!ss || !ss.isConfigured()) {
        return res.status(503).json({ error: "ShipStation not configured" });
      }

      // Resolve the canonical (non-voided) WMS shipment for this OMS order.
      const shipmentLookup = await db.execute(sql`
        SELECT s.id
          FROM wms.outbound_shipments s
          JOIN wms.orders o ON o.id = s.order_id
         WHERE o.source = 'oms'
           AND o.oms_fulfillment_order_id = ${String(id)}
           AND s.status NOT IN ('voided', 'cancelled')
         ORDER BY s.id
         LIMIT 1
      `);
      const shipmentId = shipmentLookup.rows?.[0]?.id
        ? Number(shipmentLookup.rows[0].id)
        : null;

      if (!shipmentId) {
        return res.status(409).json({
          error:
            "No active WMS shipment for this order yet — it must sync to WMS before it can be pushed to ShipStation.",
          code: "NO_WMS_SHIPMENT",
        });
      }

      const result = await ss.pushShipment(shipmentId);
      const updated = await getOms(req).getOrderById(id);

      res.json({
        shipstationOrderId: result.shipstationOrderId,
        orderKey: result.orderKey,
        order: updated,
      });
    } catch (err: any) {
      console.error("[OMS Routes] Push to ShipStation error:", err);
      res.status(err.httpStatus || 500).json({ error: err.message, code: err.code });
    }
  });
}
