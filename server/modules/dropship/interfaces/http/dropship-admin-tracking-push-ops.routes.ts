import type { Express, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipTrackingPushOpsService } from "../../application/dropship-tracking-push-ops-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipTrackingPushOpsServiceFromEnv } from "../../infrastructure/dropship-tracking-push-ops.factory";

export function registerDropshipAdminTrackingPushOpsRoutes(
  app: Express,
  service: DropshipTrackingPushOpsService = createDropshipTrackingPushOpsServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/tracking-pushes",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const result = await service.listPushes({
          statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId),
          platform: parseOptionalPlatformQuery(req.query.platform),
          search: parseOptionalStringQuery(req.query.search),
          page: parseNumberQuery(req.query.page, 1),
          limit: parseNumberQuery(req.query.limit, 50),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipTrackingPushOpsError(res, error);
      }
    },
  );
}

function sendDropshipTrackingPushOpsError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipTrackingPushOpsError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminTrackingPushOpsRoutes] Unexpected tracking push ops error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_TRACKING_PUSH_OPS_INTERNAL_ERROR",
      message: "Dropship tracking push ops request failed.",
    },
  });
}

function statusForDropshipTrackingPushOpsError(code: string): number {
  switch (code) {
    case "DROPSHIP_TRACKING_PUSH_OPS_LIST_INVALID_INPUT":
    case "DROPSHIP_TRACKING_PUSH_OPS_INTEGER_RANGE_ERROR":
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

function parseOptionalPlatformQuery(value: unknown): string | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed || parsed === "all") {
    return undefined;
  }
  return parsed;
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
