/**
 * Finance Analytics REST API
 *
 * GET /api/finance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/finance/orders?from=&to=&channelId=&financialStatus=&page=&pageSize=
 * GET /api/finance/orders/:id
 */

import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import { getFinanceSummary, getFinanceOrders, getFinanceOrderDetail } from "./finance-analytics.service";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

export function registerFinanceAnalyticsRoutes(app: Express) {
  app.get("/api/finance/summary", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const fromParam = req.query.from as string | undefined;
      const toParam = req.query.to as string | undefined;

      const now = new Date();
      const from = fromParam ? startOfDay(new Date(fromParam)) : startOfDay(now);
      const to = toParam ? endOfDay(new Date(toParam)) : endOfDay(now);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
        return;
      }

      const summary = await getFinanceSummary(from, to);
      res.json(summary);
    } catch (err: any) {
      console.error("[FinanceAnalytics] summary failed:", err);
      res.status(500).json({ error: "Failed to load finance summary" });
    }
  });

  app.get("/api/finance/orders", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const fromParam = req.query.from as string | undefined;
      const toParam = req.query.to as string | undefined;

      const now = new Date();
      const from = fromParam ? startOfDay(new Date(fromParam)) : startOfDay(now);
      const to = toParam ? endOfDay(new Date(toParam)) : endOfDay(now);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
        return;
      }

      const channelId = req.query.channelId ? Number(req.query.channelId) : undefined;
      const financialStatus = req.query.financialStatus as string | undefined;
      const page = req.query.page ? Number(req.query.page) : 1;
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);

      const result = await getFinanceOrders({ from, to, channelId, financialStatus, page, pageSize });
      res.json(result);
    } catch (err: any) {
      console.error("[FinanceAnalytics] orders failed:", err);
      res.status(500).json({ error: "Failed to load finance orders" });
    }
  });

  app.get("/api/finance/orders/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id || isNaN(id)) {
        res.status(400).json({ error: "Invalid order ID" });
        return;
      }

      const detail = await getFinanceOrderDetail(id);
      if (!detail) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      res.json(detail);
    } catch (err: any) {
      console.error("[FinanceAnalytics] order detail failed:", err);
      res.status(500).json({ error: "Failed to load order detail" });
    }
  });
}
