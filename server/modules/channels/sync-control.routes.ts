/**
 * Sync Control API Routes
 *
 * Endpoints for managing sync settings, sync log, and sync status.
 */

import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import { createManualSyncRunner } from "./manual-sync-runner";

export function registerSyncControlRoutes(app: Express) {
  const manualSync = createManualSyncRunner();
  // ============================================
  // GLOBAL SYNC SETTINGS
  // ============================================

  // Get global sync settings
  app.get("/api/sync/settings", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const settings = await syncSettings.getGlobalSettings();
      res.json(settings);
    } catch (error: any) {
      console.error("Error fetching sync settings:", error);
      res.status(500).json({ error: error.message || "Failed to fetch sync settings" });
    }
  });

  // Update global sync settings
  app.put("/api/sync/settings", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const { globalEnabled, sweepIntervalMinutes } = req.body;

      const updates: any = {};
      if (globalEnabled !== undefined) updates.globalEnabled = globalEnabled;
      if (sweepIntervalMinutes !== undefined) updates.sweepIntervalMinutes = sweepIntervalMinutes;

      const updated = await syncSettings.updateGlobalSettings(updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating sync settings:", error);
      res.status(500).json({ error: error.message || "Failed to update sync settings" });
    }
  });

  // ============================================
  // PER-CHANNEL SYNC CONFIG
  // ============================================

  // Get channel sync config
  app.get("/api/sync/channels/:channelId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const channelId = parseInt(req.params.channelId);
      const config = await syncSettings.getChannelSyncConfig(channelId);
      if (!config) {
        return res.status(404).json({ error: "Channel not found" });
      }
      res.json(config);
    } catch (error: any) {
      console.error("Error fetching channel sync config:", error);
      res.status(500).json({ error: error.message || "Failed to fetch channel sync config" });
    }
  });

  // Update channel sync config
  app.put("/api/sync/channels/:channelId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const channelId = parseInt(req.params.channelId);
      const { syncEnabled, syncMode, sweepIntervalMinutes } = req.body;

      const updates: any = {};
      if (syncEnabled !== undefined) updates.syncEnabled = syncEnabled;
      if (syncMode !== undefined) updates.syncMode = syncMode;
      if (sweepIntervalMinutes !== undefined) updates.sweepIntervalMinutes = sweepIntervalMinutes;

      await syncSettings.updateChannelSyncConfig(channelId, updates);

      const updated = await syncSettings.getChannelSyncConfig(channelId);
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating channel sync config:", error);
      res.status(500).json({ error: error.message || "Failed to update channel sync config" });
    }
  });

  // ============================================
  // WAREHOUSE FEED TOGGLE
  // ============================================

  // Update warehouse feed_enabled
  app.put("/api/sync/warehouses/:warehouseId/feed", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const warehouseId = parseInt(req.params.warehouseId);
      const { feedEnabled } = req.body;

      if (feedEnabled === undefined) {
        return res.status(400).json({ error: "feedEnabled is required" });
      }

      await syncSettings.updateWarehouseFeedEnabled(warehouseId, feedEnabled);
      res.json({ warehouseId, feedEnabled });
    } catch (error: any) {
      console.error("Error updating warehouse feed toggle:", error);
      res.status(500).json({ error: error.message || "Failed to update warehouse feed toggle" });
    }
  });

  // ============================================
  // SYNC LOG
  // ============================================

  // Get sync log entries (paginated, filterable)
  app.get("/api/sync/log", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;

      const params: any = {
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      };

      if (req.query.channelId) params.channelId = parseInt(req.query.channelId as string);
      if (req.query.status) params.status = req.query.status as string;
      if (req.query.dateFrom) params.dateFrom = new Date(req.query.dateFrom as string);
      if (req.query.dateTo) params.dateTo = new Date(req.query.dateTo as string);

      const result = await syncSettings.getSyncLog(params);
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching sync log:", error);
      res.status(500).json({ error: error.message || "Failed to fetch sync log" });
    }
  });

  // Get sync log summary (last 24h)
  app.get("/api/sync/log/summary", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { syncSettings } = req.app.locals.services;
      const hoursBack = parseInt(req.query.hours as string) || 24;
      const summary = await syncSettings.getSyncLogSummary(hoursBack);
      res.json(summary);
    } catch (error: any) {
      console.error("Error fetching sync log summary:", error);
      res.status(500).json({ error: error.message || "Failed to fetch sync log summary" });
    }
  });

  // ============================================
  // SYNC STATUS (combines global + channels)
  // ============================================

  app.get("/api/sync/status", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { syncSettings: syncSettingsSvc } = req.app.locals.services;
      const global = await syncSettingsSvc.getGlobalSettings();

      // Get all channels with sync config using dynamic imports to avoid circular deps
      const { db } = await import("../../storage/base");
      const { channels: channelsTable } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");

      const allChannels = await db
        .select({
          id: channelsTable.id,
          name: channelsTable.name,
          provider: channelsTable.provider,
          status: channelsTable.status,
          syncEnabled: channelsTable.syncEnabled,
          syncMode: channelsTable.syncMode,
          sweepIntervalMinutes: channelsTable.sweepIntervalMinutes,
        })
        .from(channelsTable)
        .where(eqOp(channelsTable.status, "active"));

      const summary = await syncSettingsSvc.getSyncLogSummary(24);

      res.json({
        global,
        channels: allChannels.map((c: any) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          syncEnabled: c.syncEnabled ?? false,
          syncMode: c.syncMode ?? "dry_run",
          sweepIntervalMinutes: c.sweepIntervalMinutes ?? 15,
        })),
        summary,
      });
    } catch (error: any) {
      console.error("Error fetching sync status:", error);
      res.status(500).json({ error: error.message || "Failed to fetch sync status" });
    }
  });

  // ============================================
  // MANUAL SYNC TRIGGER
  // ============================================

  // Starts the sweep in the BACKGROUND and answers 202 immediately — a full
  // sweep exceeds Heroku's 30s router limit, so the old synchronous response
  // died as H12/503 while the sweep kept running (manual-sync-runner.ts).
  app.post("/api/sync/trigger", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { syncSettings: syncSettingsSvc } = req.app.locals.services;

      const global = await syncSettingsSvc.getGlobalSettings();
      if (!global.globalEnabled) {
        return res.status(400).json({ error: "Global sync is disabled" });
      }

      const outcome = manualSync.trigger(req.app.locals.services);
      if (outcome === "already_running") {
        return res.status(409).json({
          error: "A manual sync is already running",
          status: manualSync.getStatus(),
        });
      }

      res.status(202).json({
        message: "Sync started — progress lands in the sync log; poll /api/sync/trigger/status",
        status: manualSync.getStatus(),
      });
    } catch (error: any) {
      console.error("Error triggering sync:", error);
      res.status(500).json({ error: error.message || "Failed to trigger sync" });
    }
  });

  // In-flight state + last outcome of the manual sweep
  app.get("/api/sync/trigger/status", requirePermission("channels", "view"), (_req, res) => {
    res.json(manualSync.getStatus());
  });
}
