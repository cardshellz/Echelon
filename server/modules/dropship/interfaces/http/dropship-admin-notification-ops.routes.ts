import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipNotificationOpsService } from "../../application/dropship-notification-ops-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipNotificationOpsServiceFromEnv } from "../../infrastructure/dropship-notification-ops.factory";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminNotificationOpsRoutes(
  app: Express,
  service: DropshipNotificationOpsService = createDropshipNotificationOpsServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/notifications",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const result = await service.listEvents({
          statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
          channels: parseChannelsQuery(req.query.channels ?? req.query.channel),
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          critical: parseOptionalBooleanQuery(req.query.critical),
          search: parseOptionalStringQuery(req.query.search),
          page: parseNumberQuery(req.query.page, 1),
          limit: parseNumberQuery(req.query.limit, 50),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipNotificationOpsError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/notifications/:notificationEventId/retry",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.retryEvent({
          notificationEventId: parsePositiveInteger(req.params.notificationEventId, "notificationEventId"),
          reason: parseOptionalBodyString(req.body?.reason),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipNotificationOpsError(res, error);
      }
    },
  );
}

function sendDropshipNotificationOpsError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipNotificationOpsError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminNotificationOpsRoutes] Unexpected notification ops error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_NOTIFICATION_OPS_INTERNAL_ERROR",
      message: "Dropship notification ops request failed.",
    },
  });
}

function statusForDropshipNotificationOpsError(code: string): number {
  switch (code) {
    case "DROPSHIP_NOTIFICATION_OPS_LIST_INVALID_INPUT":
    case "DROPSHIP_NOTIFICATION_OPS_RETRY_INVALID_INPUT":
    case "DROPSHIP_NOTIFICATION_OPS_INVALID_REQUEST":
    case "DROPSHIP_NOTIFICATION_OPS_INTEGER_RANGE_ERROR":
      return 400;
    case "DROPSHIP_NOTIFICATION_OPS_EVENT_NOT_FOUND":
      return 404;
    case "DROPSHIP_NOTIFICATION_OPS_STATUS_NOT_RETRYABLE":
      return 409;
    default:
      return 500;
  }
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_OPS_INVALID_REQUEST",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  return {
    actorType: "admin",
    actorId: sessionUser(req)?.id,
  };
}

function sessionUser(req: Request): SessionUser | null {
  const candidate = req.session.user as SessionUser | undefined;
  return candidate?.id ? candidate : null;
}

function parseStatusesQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const statuses = value.flatMap((entry) => parseStatusesQuery(entry) ?? []);
    return statuses.length > 0 ? statuses : undefined;
  }
  const parsed = parseOptionalStringQuery(value);
  if (!parsed || parsed === "default") {
    return undefined;
  }
  return parsed.split(",").map((status) => status.trim()).filter(Boolean);
}

function parseChannelsQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const channels = value.flatMap((entry) => parseChannelsQuery(entry) ?? []);
    return channels.length > 0 ? channels : undefined;
  }
  const parsed = parseOptionalStringQuery(value);
  if (!parsed || parsed === "all") {
    return undefined;
  }
  return parsed.split(",").map((channel) => channel.trim()).filter(Boolean);
}

function parseOptionalBooleanQuery(value: unknown): boolean | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed || parsed === "all") {
    return undefined;
  }
  if (parsed === "true") {
    return true;
  }
  if (parsed === "false") {
    return false;
  }
  throw new DropshipError(
    "DROPSHIP_NOTIFICATION_OPS_LIST_INVALID_INPUT",
    "Dropship notification critical filter must be true, false, or all.",
    { field: "critical", value: parsed },
  );
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  return Number(parsed);
}

function parseNumberQuery(value: unknown, fallback: number): number {
  return parseOptionalPositiveIntegerQuery(value) ?? fallback;
}

function parseOptionalBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_OPS_INVALID_REQUEST",
      "Route parameter must be a positive integer.",
      { key, value },
    );
  }
  return parsed;
}
