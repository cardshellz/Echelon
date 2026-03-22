// subscription.routes.ts — Admin API routes for subscription management
import type { Express, Request, Response } from "express";
import * as storage from "./subscription.storage";
import * as service from "./subscription.service";
import { createSellingPlanGroup, listSellingPlanGroups, registerSubscriptionWebhooks } from "./selling-plan.service";
import { processDueBillings } from "./subscription.scheduler";

/**
 * Register admin subscription routes (behind Echelon auth).
 */
export function registerSubscriptionRoutes(app: Express): void {
  // ─── Dashboard Stats ──────────────────────────────────────────
  app.get("/api/subscriptions/dashboard", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (err: any) {
      console.error("[SubRoutes] Dashboard error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Subscriber List ──────────────────────────────────────────
  app.get("/api/subscriptions/list", async (req: Request, res: Response) => {
    try {
      const { status, billing_status, tier, search, limit, offset } = req.query;
      const result = await storage.getSubscriberList({
        status: status as string,
        billing_status: billing_status as string,
        tier: tier as string,
        search: search as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] List error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Subscription Detail ──────────────────────────────────────
  app.get("/api/subscriptions/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const detail = await storage.getSubscriptionDetail(id);
      if (!detail) return res.status(404).json({ error: "Subscription not found" });

      // Get billing logs and events
      const billingLogs = await storage.getBillingLogs({ member_subscription_id: id, limit: 20 });
      const events = await storage.getEvents({ member_subscription_id: id, limit: 50 });

      res.json({ subscription: detail, billingLogs: billingLogs.rows, events });
    } catch (err: any) {
      console.error("[SubRoutes] Detail error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Cancel Subscription ──────────────────────────────────────
  app.post("/api/subscriptions/:id/cancel", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const reason = req.body?.reason || "Admin cancelled";
      await service.cancelSubscription(id, reason);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[SubRoutes] Cancel error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Change Plan ──────────────────────────────────────────────
  app.post("/api/subscriptions/:id/change-plan", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const newPlanId = req.body?.plan_id;
      if (!newPlanId) return res.status(400).json({ error: "plan_id required" });
      await service.changePlan(id, newPlanId);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[SubRoutes] Change plan error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Retry Billing ────────────────────────────────────────────
  app.post("/api/subscriptions/:id/retry-billing", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const result = await service.retryBilling(id);
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] Retry billing error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Pause/Unpause ────────────────────────────────────────────
  app.post("/api/subscriptions/:id/pause", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const paused = req.body?.paused !== false; // default to true
      await service.pauseSubscription(id, paused);
      res.json({ success: true, paused });
    } catch (err: any) {
      console.error("[SubRoutes] Pause error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Plans ────────────────────────────────────────────────────
  app.get("/api/subscriptions/plans/list", async (_req: Request, res: Response) => {
    try {
      const plans = await storage.getAllPlans();
      const sellingPlanMap = await storage.getSellingPlanMap();
      res.json({ plans, sellingPlanMap });
    } catch (err: any) {
      console.error("[SubRoutes] Plans list error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/subscriptions/plans/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const { name, tier, billing_interval, price_cents, includes_dropship, is_active } = req.body;
      await storage.updatePlanDetails(id, {
        name, tier, billing_interval, price_cents, includes_dropship, is_active,
      });
      res.json({ success: true });
    } catch (err: any) {
      console.error("[SubRoutes] Plan update error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Billing Log ──────────────────────────────────────────────
  app.get("/api/subscriptions/billing/log", async (req: Request, res: Response) => {
    try {
      const { status, limit, offset } = req.query;
      const result = await storage.getBillingLogs({
        status: status as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] Billing log error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Events ───────────────────────────────────────────────────
  app.get("/api/subscriptions/events/list", async (req: Request, res: Response) => {
    try {
      const { event_type, limit } = req.query;
      const events = await storage.getEvents({
        event_type: event_type as string,
        limit: limit ? parseInt(limit as string) : 100,
      });
      res.json(events);
    } catch (err: any) {
      console.error("[SubRoutes] Events error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Setup Selling Plans ──────────────────────────────────────
  app.post("/api/membership/setup-selling-plans", async (req: Request, res: Response) => {
    try {
      const productGid = req.body?.product_gid || process.env.SHOPIFY_MEMBERSHIP_PRODUCT_GID;
      if (!productGid) {
        return res.status(400).json({ error: "product_gid required (or set SHOPIFY_MEMBERSHIP_PRODUCT_GID env var)" });
      }
      const result = await createSellingPlanGroup(productGid);
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] Setup selling plans error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Register Webhooks ────────────────────────────────────────
  app.post("/api/membership/register-webhooks", async (req: Request, res: Response) => {
    try {
      const baseUrl = req.body?.base_url || `https://${req.headers.host}`;
      const registered = await registerSubscriptionWebhooks(baseUrl);
      res.json({ registered });
    } catch (err: any) {
      console.error("[SubRoutes] Webhook registration error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Shopify Selling Plans (read from Shopify) ────────────────
  app.get("/api/membership/shopify-selling-plans", async (_req: Request, res: Response) => {
    try {
      const groups = await listSellingPlanGroups();
      res.json(groups);
    } catch (err: any) {
      console.error("[SubRoutes] Shopify plans error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Manual Billing Run ───────────────────────────────────────
  app.post("/api/subscriptions/billing/run", async (_req: Request, res: Response) => {
    try {
      const result = await processDueBillings();
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] Manual billing run error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log("[SubRoutes] Subscription admin routes registered");
}
