import type { Express, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipOpsSurfaceService } from "../../application/dropship-ops-surface-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipOpsSurfaceServiceFromEnv } from "../../infrastructure/dropship-ops-surface.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipOpsSurfaceRoutes(
  app: Express,
  service: DropshipOpsSurfaceService = createDropshipOpsSurfaceServiceFromEnv(),
): void {
  app.get("/api/dropship/settings", requireDropshipAuth, async (req, res) => {
    try {
      const settings = await service.getVendorSettingsForMember(req.session.dropship!.memberId);
      return res.json({ settings });
    } catch (error) {
      return sendDropshipOpsSurfaceError(res, error);
    }
  });

  app.get("/api/dropship/admin/ops/overview", requirePermission("dropship", "view"), async (req, res) => {
    try {
      const overview = await service.getAdminOpsOverview({
        vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId, "vendorId"),
        storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId, "storeConnectionId"),
      });
      return res.json({ overview });
    } catch (error) {
      return sendDropshipOpsSurfaceError(res, error);
    }
  });

  app.get("/api/dropship/admin/audit-events", requirePermission("dropship", "view"), async (req, res) => {
    try {
      const result = await service.searchAuditEvents({
        vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId, "vendorId"),
        storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId, "storeConnectionId"),
        entityType: parseOptionalStringQuery(req.query.entityType),
        entityId: parseOptionalStringQuery(req.query.entityId),
        eventType: parseOptionalStringQuery(req.query.eventType),
        severity: parseOptionalStringQuery(req.query.severity),
        search: parseOptionalStringQuery(req.query.search),
        createdFrom: parseOptionalDateQuery(req.query.createdFrom),
        createdTo: parseOptionalDateQuery(req.query.createdTo),
        page: parsePositiveIntegerQuery(req.query.page, "page", 1),
        limit: parsePositiveIntegerQuery(req.query.limit, "limit", 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipOpsSurfaceError(res, error);
    }
  });

  app.get("/api/dropship/admin/dogfood-readiness", requirePermission("dropship", "view"), async (req, res) => {
    try {
      const result = await service.listDogfoodReadiness({
        status: parseOptionalStringQuery(req.query.status) === "all"
          ? undefined
          : parseOptionalStringQuery(req.query.status),
        platform: parseOptionalStringQuery(req.query.platform) === "all"
          ? undefined
          : parseOptionalStringQuery(req.query.platform),
        search: parseOptionalStringQuery(req.query.search),
        page: parsePositiveIntegerQuery(req.query.page, "page", 1),
        limit: parsePositiveIntegerQuery(req.query.limit, "limit", 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipOpsSurfaceError(res, error);
    }
  });
}

function sendDropshipOpsSurfaceError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipOpsSurfaceError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipOpsSurfaceRoutes] Unexpected ops surface error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_OPS_SURFACE_INTERNAL_ERROR",
      message: "Dropship ops surface request failed.",
    },
  });
}

function statusForDropshipOpsSurfaceError(code: string): number {
  switch (code) {
    case "DROPSHIP_OPS_OVERVIEW_INVALID_INPUT":
    case "DROPSHIP_AUDIT_SEARCH_INVALID_INPUT":
    case "DROPSHIP_DOGFOOD_READINESS_INVALID_INPUT":
    case "DROPSHIP_OPS_SURFACE_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
      return 403;
    case "DROPSHIP_VENDOR_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown, parameter: string): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) return undefined;
  const number = Number(parsed);
  if (!Number.isInteger(number) || number <= 0) {
    throw new DropshipError(
      "DROPSHIP_OPS_SURFACE_INVALID_REQUEST",
      "Query parameter must be a positive integer.",
      { parameter, value: parsed },
    );
  }
  return number;
}

function parsePositiveIntegerQuery(value: unknown, parameter: string, fallback: number): number {
  return parseOptionalPositiveIntegerQuery(value, parameter) ?? fallback;
}

function parseOptionalDateQuery(value: unknown): Date | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) return undefined;
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) {
    throw new DropshipError(
      "DROPSHIP_OPS_SURFACE_INVALID_REQUEST",
      "Date query parameter must be a valid ISO date string.",
      { value: parsed },
    );
  }
  return date;
}
