import type { Express } from "express";
import { requireAuth, requirePermission } from "../../routes/middleware";
import * as notificationService from "./notifications.service";

function getSessionUserId(req: any): string {
  return req.user?.id ?? req.session.user!.id;
}

export function registerNotificationRoutes(app: Express) {
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const unreadOnly = req.query.unreadOnly === "true";
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const rows = await notificationService.getUserNotifications(userId, { unreadOnly, limit, offset });
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const count = await notificationService.getUnreadCount(userId);
      res.json({ count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      await notificationService.markRead(parseInt(req.params.id), userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      await notificationService.markAllRead(userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const prefs = await notificationService.getPreferencesForUser(userId);
      res.json(prefs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/notification-preferences/:typeId", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const typeId = parseInt(req.params.typeId);
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
      }
      await notificationService.setUserPreference(userId, typeId, enabled);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      await notificationService.resetUserPreferences(userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/notification-types", requirePermission("settings", "view"), async (_req, res) => {
    try {
      const types = await notificationService.getAllNotificationTypes();
      res.json(types);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
