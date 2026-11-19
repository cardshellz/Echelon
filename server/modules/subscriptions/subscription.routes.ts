// subscription.routes.ts — Admin API routes for subscription management
import type { Express, Request, Response } from "express";
import * as storage from "./infrastructure/subscription.repository";
import * as service from "./application/subscription.use-cases";
import { SubscriptionCommandError } from "./application/subscription.use-cases";
import { createSellingPlanGroupUseCase, listSellingPlanGroupsUseCase } from "./application/selling-plan.use-cases";
import { runBillingPassWithLock } from "./subscription.scheduler";
import { requireAuth, requirePermission } from "../../routes/middleware";

function staffActor(req: Request): string {
  const sessionUser = (req as any).session?.user;
  return (
    sessionUser?.username ||
    sessionUser?.email ||
    (sessionUser?.id ? `user:${sessionUser.id}` : "staff_admin")
  );
}

function parsePositiveInt(raw: unknown): number | null {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendSubscriptionCommandError(res: Response, logPrefix: string, err: unknown): void {
  if (err instanceof SubscriptionCommandError) {
    res.status(err.status).json({
      success: false,
      code: err.code,
      error: err.message,
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected subscription error";
  console.error(`${logPrefix}:`, message);
  res.status(500).json({ success: false, error: message });
}

/**
 * Register admin subscription routes (behind Echelon auth).
 */
export function registerSubscriptionRoutes(app: Express): void {
  // Apply middleware to all routes in this file
  const adminMw = [requireAuth, requirePermission("shellz", "admin")] as any;
  app.use("/api/subscriptions", ...adminMw);
  app.use("/api/membership", ...adminMw);

  // ─── Dashboard Stats ──────────────────────────────────────────
  app.get("/api/subscriptions/dashboard", requireAuth, async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (err: any) {
      console.error("[SubRoutes] Dashboard error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Subscriber List ──────────────────────────────────────────
  app.get("/api/subscriptions/list", requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, billing_status, search, limit, offset } = req.query;
      const result = await storage.getSubscriberList({
        status: status as string,
        billing_status: billing_status as string,
        search: search as string,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] List error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Subscription Detail ──────────────────────────────────────
  app.get("/api/subscriptions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Valid subscription id required" });

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
  app.post("/api/subscriptions/:id/cancel", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: "Valid subscription id required" });

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim().length > 0
          ? req.body.reason.trim()
          : "Admin cancelled";
      const result = await service.cancelSubscriptionUseCase(id, reason, staffActor(req));
      res.json(result);
    } catch (err: unknown) {
      sendSubscriptionCommandError(res, "[SubRoutes] Cancel error", err);
    }
  });

  // ─── Change Plan ──────────────────────────────────────────────
  app.post("/api/subscriptions/:id/change-plan", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: "Valid subscription id required" });

      const newPlanId = parsePositiveInt(req.body?.plan_id);
      if (!newPlanId) return res.status(400).json({ success: false, error: "Valid plan_id required" });

      await service.changePlanUseCase(id, newPlanId, staffActor(req));
      res.json({ success: true });
    } catch (err: unknown) {
      sendSubscriptionCommandError(res, "[SubRoutes] Change plan error", err);
    }
  });

  // ─── Retry Billing ────────────────────────────────────────────
  app.post("/api/subscriptions/:id/retry-billing", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: "Valid subscription id required" });

      const result = await service.retryBillingUseCase(id, staffActor(req));
      if (!result.success) {
        const status =
          result.code === "BILLING_ALREADY_IN_PROGRESS" || result.code === "SUBSCRIPTION_CANCELLED"
            ? 409
            : result.uncertain
              ? 502
              : 400;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err: unknown) {
      sendSubscriptionCommandError(res, "[SubRoutes] Retry billing error", err);
    }
  });

  // ─── Pause/Unpause ────────────────────────────────────────────
  app.post("/api/subscriptions/:id/pause", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: "Valid subscription id required" });

      const paused = req.body?.paused !== false; // default to true
      await service.pauseSubscriptionUseCase(id, paused, staffActor(req));
      res.json({ success: true, paused });
    } catch (err: unknown) {
      sendSubscriptionCommandError(res, "[SubRoutes] Pause error", err);
    }
  });

  // ─── Plans ────────────────────────────────────────────────────
  app.get("/api/subscriptions/plans/list", requireAuth, async (_req: Request, res: Response) => {
    try {
      const plans = await storage.getAllPlans();
      const sellingPlanMap = await storage.getSellingPlanMap();
      res.json({ plans, sellingPlanMap });
    } catch (err: any) {
      console.error("[SubRoutes] Plans list error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/subscriptions/plans/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: "Valid plan id required" });

      const { name, billing_interval, billing_interval_count, price_cents, includes_dropship, is_active, priority_modifier } =
        req.body ?? {};
      const plan = await service.updatePlanDetailsUseCase(
        id,
        {
          name,
          billing_interval,
          billing_interval_count,
          price_cents,
          includes_dropship,
          is_active,
          priority_modifier,
        },
        staffActor(req),
      );
      res.json({ success: true, plan });
    } catch (err: unknown) {
      sendSubscriptionCommandError(res, "[SubRoutes] Plan update error", err);
    }
  });

  // ─── Billing Log ──────────────────────────────────────────────
  app.get("/api/subscriptions/billing/log", requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, limit, offset } = req.query;
      const result = await storage.getBillingLogs({
        status: status as string,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[SubRoutes] Billing log error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Events ───────────────────────────────────────────────────
  app.get("/api/subscriptions/events/list", requireAuth, async (req: Request, res: Response) => {
    try {
      const { event_type, limit } = req.query;
      const events = await storage.getEvents({
        event_type: event_type as string,
        limit: limit ? parseInt(limit as string, 10) : 100,
      });
      res.json(events);
    } catch (err: any) {
      console.error("[SubRoutes] Events error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Setup Selling Plans ──────────────────────────────────────
  app.post("/api/membership/setup-selling-plans", requireAuth, async (req: Request, res: Response) => {
    try {
      const productGid = req.body?.product_gid || process.env.SHOPIFY_MEMBERSHIP_PRODUCT_GID;
      if (!productGid) {
        return res.status(400).json({ error: "product_gid required (or set SHOPIFY_MEMBERSHIP_PRODUCT_GID env var)" });
      }
      const result = await createSellingPlanGroupUseCase(productGid);
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[SubRoutes] Setup selling plans error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Register Webhooks ────────────────────────────────────────
  app.post("/api/membership/register-webhooks", requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        disabled: true,
        registered: [],
        message: "Subscription webhooks are disabled in Echelon and owned by shellz-club-app.",
      });
    } catch (err: any) {
      console.error("[SubRoutes] Webhook registration error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Shopify Selling Plans (read from Shopify) ────────────────
  app.get("/api/membership/shopify-selling-plans", requireAuth, async (_req: Request, res: Response) => {
    try {
      const groups = await listSellingPlanGroupsUseCase();
      res.json(groups);
    } catch (err: any) {
      console.error("[SubRoutes] Shopify plans error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Manual Billing Run ───────────────────────────────────────
  app.post("/api/subscriptions/billing/run", requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await runBillingPassWithLock();
      if (result.skipped) {
        return res.status(409).json({
          success: false,
          ...result,
          error: "A subscription billing run is already in progress.",
        });
      }
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[SubRoutes] Manual billing run error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log("[SubRoutes] Subscription admin routes registered");
}
