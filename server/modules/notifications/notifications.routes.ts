import type { Express, Response } from "express";
import { requireAuth, requirePermission } from "../../routes/middleware";
import * as notificationService from "./notifications.service";

function getSessionUserId(req: any): string {
  return req.user?.id ?? req.session.user!.id;
}

function parsePositiveIntParam(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    return null;
  }
  return parsed;
}

export function parseNotificationPaginationQuery(query: Record<string, unknown>): {
  unreadOnly: boolean;
  limit: number;
  offset: number;
} {
  const unreadOnly = query.unreadOnly === "true";
  const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const rawOffset = typeof query.offset === "string" ? Number.parseInt(query.offset, 10) : Number.NaN;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { unreadOnly, limit, offset };
}

function handleNotificationRouteError(res: Response, err: unknown, fallbackMessage: string): void {
  if (
    err &&
    typeof err === "object" &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number" &&
    (err as { statusCode: number }).statusCode >= 400 &&
    (err as { statusCode: number }).statusCode < 500
  ) {
    const typed = err as { statusCode: number; message?: string; code?: string };
    res.status(typed.statusCode).json({
      error: typed.message || fallbackMessage,
      ...(typeof typed.code === "string" ? { code: typed.code } : {}),
    });
    return;
  }
  console.error(`[Notifications Routes] ${fallbackMessage}`, err);
  res.status(500).json({ error: fallbackMessage });
}

export function registerNotificationRoutes(app: Express) {
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const filters = parseNotificationPaginationQuery(req.query as Record<string, unknown>);
      const rows = await notificationService.getUserNotifications(userId, filters);
      res.json(rows);
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to load notifications");
    }
  });

  app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const count = await notificationService.getUnreadCount(userId);
      res.json({ count });
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to load unread notification count");
    }
  });

  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const notificationId = parsePositiveIntParam(req.params.id);
      if (notificationId === null) {
        return res.status(400).json({ error: "Valid notification id is required" });
      }
      await notificationService.markRead(notificationId, userId);
      res.json({ ok: true });
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to mark notification as read");
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      await notificationService.markAllRead(userId);
      res.json({ ok: true });
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to mark notifications as read");
    }
  });

  app.get("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const prefs = await notificationService.getPreferencesForUser(userId);
      res.json(prefs);
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to load notification preferences");
    }
  });

  app.put("/api/notification-preferences/:typeId", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const typeId = parsePositiveIntParam(req.params.typeId);
      if (typeId === null) {
        return res.status(400).json({ error: "Valid notification type id is required" });
      }
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
      }
      await notificationService.setUserPreference(userId, typeId, enabled);
      res.json({ ok: true });
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to update notification preference");
    }
  });

  app.delete("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      await notificationService.resetUserPreferences(userId);
      res.json({ ok: true });
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to reset notification preferences");
    }
  });

  app.get("/api/notification-types", requirePermission("settings", "view"), async (_req, res) => {
    try {
      const types = await notificationService.getAllNotificationTypes();
      res.json(types);
    } catch (err: unknown) {
      handleNotificationRouteError(res, err, "Failed to load notification types");
    }
  });
}
