import type { Express, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipNotificationOpsService } from "../../application/dropship-notification-ops-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipNotificationOpsServiceFromEnv } from "../../infrastructure/dropship-notification-ops.factory";

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
    case "DROPSHIP_NOTIFICATION_OPS_INTEGER_RANGE_ERROR":
      return 400;
    default:
      return 500;
  }
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
