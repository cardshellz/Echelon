/**
 * Enterprise Operations Dashboard REST API — Phase 7B
 *
 * Single consolidated endpoint for full operational visibility.
 * Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD for date-sensitive KPIs.
 */

import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import { getEnterpriseDashboard } from "./enterprise-dashboard.service";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

export function registerEnterpriseDashboardRoutes(app: Express) {
  app.get("/api/enterprise/dashboard", requirePermission("inventory", "view"), async (req, res) => {
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

      const dashboard = await getEnterpriseDashboard({ from, to });
      res.json(dashboard);
    } catch (err: any) {
      console.error("[EnterpriseDashboard] failed:", err);
      res.status(500).json({ error: "Failed to load enterprise dashboard" });
    }
  });
}
