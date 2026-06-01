/**
 * Enterprise Operations Dashboard REST API — Phase 7B
 *
 * Single consolidated endpoint for full operational visibility.
 */

import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import { getEnterpriseDashboard } from "./enterprise-dashboard.service";

export function registerEnterpriseDashboardRoutes(app: Express) {
  app.get("/api/enterprise/dashboard", requirePermission("inventory", "view"), async (_req, res) => {
    try {
      const dashboard = await getEnterpriseDashboard();
      res.json(dashboard);
    } catch (err: any) {
      console.error("[EnterpriseDashboard] failed:", err);
      res.status(500).json({ error: "Failed to load enterprise dashboard" });
    }
  });
}
