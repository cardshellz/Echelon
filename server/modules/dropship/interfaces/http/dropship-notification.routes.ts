import type { Express, Response } from "express";
import { DropshipError } from "../../domain/errors";
import type { DropshipNotificationService } from "../../application/dropship-notification-service";
import { createDropshipNotificationServiceFromEnv } from "../../infrastructure/dropship-notification.factory";
import { requireDropshipAuth, requireDropshipSensitiveActionProof } from "./dropship-auth.routes";

export function registerDropshipNotificationRoutes(
  app: Express,
  service: DropshipNotificationService = createDropshipNotificationServiceFromEnv(),
): void {
  app.get("/api/dropship/notifications", requireDropshipAuth, async (req, res) => {
    try {
      const result = await service.listForMember(req.session.dropship!.memberId, {
        unreadOnly: parseBooleanQuery(req.query.unreadOnly),
        page: parsePositiveIntegerQuery(req.query.page, 1),
        limit: parsePositiveIntegerQuery(req.query.limit, 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipNotificationError(res, error);
    }
  });

  app.post("/api/dropship/notifications/:notificationEventId/read", requireDropshipAuth, async (req, res) => {
    try {
      const notification = await service.markReadForMember(
        req.session.dropship!.memberId,
        parsePositiveInteger(req.params.notificationEventId, "notificationEventId"),
      );
      return res.json({ notification });
    } catch (error) {
      return sendDropshipNotificationError(res, error);
    }
  });

  app.get("/api/dropship/notification-preferences", requireDropshipAuth, async (req, res) => {
    try {
      const preferences = await service.listPreferencesForMember(req.session.dropship!.memberId);
      return res.json({ preferences });
    } catch (error) {
      return sendDropshipNotificationError(res, error);
    }
  });

  app.put(
    "/api/dropship/notification-preferences/:eventType",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("manage_notification_preferences"),
    async (req, res) => {
      try {
        const preference = await service.updatePreferenceForMember(
          req.session.dropship!.memberId,
          req.params.eventType,
          req.body,
        );
        return res.json({ preference });
      } catch (error) {
        return sendDropshipNotificationError(res, error);
      }
    },
  );
}

function sendDropshipNotificationError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipNotificationError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipNotificationRoutes] Unexpected notification error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_NOTIFICATION_INTERNAL_ERROR",
      message: "Dropship notification request failed.",
    },
  });
}

function statusForDropshipNotificationError(code: string): number {
  switch (code) {
    case "DROPSHIP_NOTIFICATION_INVALID_SEND":
    case "DROPSHIP_NOTIFICATION_INVALID_LIST":
    case "DROPSHIP_NOTIFICATION_INVALID_PREFERENCE":
    case "DROPSHIP_NOTIFICATION_CHANNEL_UNSUPPORTED":
    case "DROPSHIP_NOTIFICATION_CRITICAL_MUTE_REJECTED":
    case "DROPSHIP_NOTIFICATION_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_STEP_UP_REQUIRED":
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
      return 403;
    case "DROPSHIP_NOTIFICATION_NOT_FOUND":
      return 404;
    case "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parsePositiveIntegerQuery(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_NOTIFICATION_INVALID_REQUEST", "Route parameter must be a positive integer.", {
      key,
      value,
    });
  }
  return parsed;
}
