import { requireAuth, requirePermission } from "./middleware";
/**
 * OMS API Routes
 *
 * Unified order management endpoints.
 */

import type { Express, Request, Response } from "express";
import type { OmsService } from "../modules/oms/oms.service";
import type { ShipStationService } from "../modules/oms/shipstation.service";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getOmsOpsHealth } from "../modules/oms/ops-health.service";
import { getFlowWaterfall, getFlowBucketSamples } from "../modules/oms/flow-waterfall.service";
import { getFlowTrace } from "../modules/oms/flow-trace.service";
import {
  remediateOmsFlowIssue,
  type OmsFlowReconciliationDependencies,
} from "../modules/oms/oms-flow-reconciliation.service";
import { enqueueWebhookInboxReplay } from "../modules/oms/webhook-inbox.service";
import { requeueDeadWebhookRetry } from "../modules/oms/webhook-retry.worker";
import { hasPermission } from "../modules/identity";
import {
  adoptShipStationUnmappedPhysicalAsReship,
  getShipStationUnmappedPhysicalPreview,
  resolveShipStationUnmappedPhysicalAsVoidedLabel,
} from "../modules/oms/shipstation-unmapped-remediation.service";

export function registerOmsRoutes(app: Express) {
  const getOms = (req: Request): OmsService => (req.app.locals.services as any).oms;
  const getShipStation = (req: Request): ShipStationService | null =>
    (req.app.locals.services as any).shipStation || null;
  const getFlowReconciliationDependencies = (
    req: Request,
  ): OmsFlowReconciliationDependencies => {
    const services = req.app.locals.services as any;
    if (!services?.channelFulfillmentAuthority) {
      throw new Error("Canonical fulfillment authority is unavailable");
    }
    return {
      reservation: services.reservation ?? null,
      fulfillmentAuthority: services.channelFulfillmentAuthority,
    };
  };

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
  // GET /api/oms/ops/flow-waterfall — funnel view of where orders diverge
  // (read-only: throughput + open-exception buckets, tagged by funnel stage)
  // -----------------------------------------------------------------------
  app.get("/api/oms/ops/flow-waterfall", requireAuth, async (req: Request, res: Response) => {
    try {
      const requested = Number(req.query.windowDays);
      const windowDays =
        Number.isFinite(requested) && requested > 0
          ? Math.min(365, Math.floor(requested))
          : undefined;
      res.json(await getFlowWaterfall(db, { windowDays }));
    } catch (err: any) {
      console.error("[OMS Routes] Flow waterfall error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/oms/ops/flow-bucket/:code — on-demand drill-down rows for one
  // exception bucket (read-only, single connection, LIMIT 50)
  // -----------------------------------------------------------------------
  app.get("/api/oms/ops/flow-bucket/:code", requireAuth, async (req: Request, res: Response) => {
    try {
      const code = String(req.params.code ?? "").trim();
      const requested = Number(req.query.windowDays);
      const windowDays =
        Number.isFinite(requested) && requested > 0
          ? Math.min(365, Math.floor(requested))
          : undefined;
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await getFlowBucketSamples(db, code, { windowDays }));
    } catch (err: any) {
      console.error("[OMS Routes] Flow bucket error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get(
    "/api/oms/ops/shipstation-unmapped/preview",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const shipStation = getShipStation(req);
        if (!shipStation) {
          res.status(503).json({ error: "ShipStation service is unavailable" });
          return;
        }
        res.setHeader("Cache-Control", "private, no-store");
        res.json(await getShipStationUnmappedPhysicalPreview(db, shipStation, {
          exceptionId: req.query.exceptionId == null ? undefined : Number(req.query.exceptionId),
          shipmentId: req.query.shipmentId == null ? undefined : Number(req.query.shipmentId),
        }));
      } catch (err: any) {
        console.error("[OMS Routes] ShipStation unmapped preview error:", err);
        const message = err?.message || "Failed to load ShipStation remediation evidence";
        const status = /positive integer|exactly one|required/i.test(message)
          ? 400
          : /not found/i.test(message)
            ? 404
            : /unavailable/i.test(message)
              ? 503
              : 409;
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    "/api/oms/ops/shipstation-unmapped/resolve-voided-label",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
      try {
        const shipStation = getShipStation(req);
        if (!shipStation) {
          res.status(503).json({ error: "ShipStation service is unavailable" });
          return;
        }
        const operator =
          req.session.user?.username ||
          req.session.user?.displayName ||
          String(req.session.user?.id || "unknown");
        res.json(await resolveShipStationUnmappedPhysicalAsVoidedLabel(
          db,
          shipStation,
          {
            exceptionId: req.body?.exceptionId,
            shipmentId: req.body?.shipmentId,
            notes: req.body?.notes,
            operator,
          },
        ));
      } catch (err: any) {
        console.error("[OMS Routes] ShipStation voided-label resolution error:", err);
        const message = err?.message || "Failed to resolve ShipStation voided label";
        const status = /positive integer|exactly one|required|does not report/i.test(message)
          ? 400
          : /not found/i.test(message)
            ? 404
            : /unavailable/i.test(message)
              ? 503
              : 409;
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    "/api/oms/ops/shipstation-unmapped/adopt-reship",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
      try {
        const shipStation = getShipStation(req);
        if (!shipStation) {
          res.status(503).json({ error: "ShipStation service is unavailable" });
          return;
        }
        const userId = req.session.user?.id;
        if (!userId || !(await hasPermission(userId, "inventory", "adjust"))) {
          res.status(403).json({ error: "Permission denied: inventory:adjust" });
          return;
        }
        const operator =
          req.session.user?.username ||
          req.session.user?.displayName ||
          String(req.session.user?.id || "unknown");
        res.json(await adoptShipStationUnmappedPhysicalAsReship(db, shipStation, {
          exceptionId: req.body?.exceptionId,
          shipmentId: req.body?.shipmentId,
          originalShipmentId: req.body?.originalShipmentId,
          reason: req.body?.reason,
          notes: req.body?.notes,
          lineMappings: req.body?.lineMappings,
          operator,
        }));
      } catch (err: any) {
        console.error("[OMS Routes] ShipStation reship adoption error:", err);
        const message = err?.message || "Failed to adopt ShipStation reship";
        const status = /positive integer|exactly one|required|valid|must equal|does not match/i.test(message)
          ? 400
          : /not found/i.test(message)
            ? 404
            : /unavailable/i.test(message)
              ? 503
              : 409;
        res.status(status).json({ error: message });
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/oms/ops/flow-trace?ref=<order number|id> — per-order life story
  // (read-only: cross-system trace + computed stage ladder + raw timeline)
  // -----------------------------------------------------------------------
  app.get("/api/oms/ops/flow-trace/:ref", requireAuth, async (req: Request, res: Response) => {
    try {
      const ref = String(req.params.ref ?? "").trim();
      if (!ref) {
        res.status(400).json({ error: "ref path param required" });
        return;
      }
      res.json(await getFlowTrace(db, ref));
    } catch (err: any) {
      console.error("[OMS Routes] Flow trace error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/oms/ops/webhook-inbox/:id/replay",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
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
    },
  );

  app.post(
    "/api/oms/ops/webhook-retry/:id/requeue",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
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
    },
  );

  app.post(
    "/api/oms/ops/reconciliation/remediate",
    requirePermission("operations", "triage"),
    async (req: Request, res: Response) => {
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
        }, getFlowReconciliationDependencies(req));
        res.json(result);
      } catch (err: any) {
        console.error("[OMS Routes] Reconciliation remediation error:", err);
        const message = err?.message || "Failed to remediate OMS flow issue";
        const status = /positive integer/i.test(message)
          ? 400
          : /unsupported|no succeeded Shopify orders\/paid|no longer replayable/i.test(message)
            ? 409
            : 500;
        res.status(status).json({ error: message });
      }
    },
  );

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
    return res.status(409).json({
      code: "PHYSICAL_SHIPMENT_REQUIRED",
      error:
        "An OMS order cannot be marked shipped directly. Record the package and its exact items through the WMS or shipping workflow.",
    });
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

      // overrideReview = an explicit operator "clear-review-and-push" (P2 of
      // ENGINE-CANCEL-DIVERGENCE-DESIGN.md). It bypasses the requires_review /
      // cancelled-SS-order guards and clears the review flag, so it is gated on
      // the same privileged permission as holds (admin/lead, not pickers).
      const overrideReview = req.body?.overrideReview === true;
      if (overrideReview) {
        const userId = req.session.user?.id;
        if (!userId || !(await hasPermission(userId, "orders", "hold"))) {
          return res.status(403).json({
            error: "Permission denied: orders:hold is required to override a review flag",
          });
        }
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

      const result = await ss.pushShipment(shipmentId, { overrideReview });
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
