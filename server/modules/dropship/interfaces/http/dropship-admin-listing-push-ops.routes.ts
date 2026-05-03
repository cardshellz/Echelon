import type { Express, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipListingPushOpsService } from "../../application/dropship-listing-push-ops-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingPushOpsServiceFromEnv } from "../../infrastructure/dropship-listing-push-ops.factory";

export function registerDropshipAdminListingPushOpsRoutes(
  app: Express,
  service: DropshipListingPushOpsService = createDropshipListingPushOpsServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/listing-push-jobs",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const result = await service.listJobs({
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
        return sendDropshipListingPushOpsError(res, error);
      }
    },
  );
}

function sendDropshipListingPushOpsError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipListingPushOpsError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminListingPushOpsRoutes] Unexpected listing push ops error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_LISTING_PUSH_OPS_INTERNAL_ERROR",
      message: "Dropship listing push ops request failed.",
    },
  });
}

function statusForDropshipListingPushOpsError(code: string): number {
  switch (code) {
    case "DROPSHIP_LISTING_PUSH_OPS_LIST_INVALID_INPUT":
    case "DROPSHIP_LISTING_PUSH_OPS_INTEGER_RANGE_ERROR":
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
