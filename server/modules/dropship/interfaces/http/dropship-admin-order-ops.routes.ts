import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipError } from "../../domain/errors";
import type { DropshipOrderOpsService } from "../../application/dropship-order-ops-service";
import { createDropshipOrderOpsServiceFromEnv } from "../../infrastructure/dropship-order-ops.factory";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminOrderOpsRoutes(
  app: Express,
  service: DropshipOrderOpsService = createDropshipOrderOpsServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/order-intake",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const result = await service.listIntakes({
          statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId),
          search: parseOptionalStringQuery(req.query.search),
          page: parseNumberQuery(req.query.page, 1),
          limit: parseNumberQuery(req.query.limit, 50),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipOrderOpsError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/order-intake/:intakeId/retry",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.retryIntake({
          intakeId: parsePositiveInteger(req.params.intakeId, "intakeId"),
          reason: parseOptionalBodyString(req.body?.reason),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipOrderOpsError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/order-intake/:intakeId/exception",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.markException({
          intakeId: parsePositiveInteger(req.params.intakeId, "intakeId"),
          reason: parseRequiredBodyString(req.body?.reason, "reason"),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipOrderOpsError(res, error);
      }
    },
  );
}

function sendDropshipOrderOpsError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipOrderOpsError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminOrderOpsRoutes] Unexpected order ops error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_ORDER_OPS_INTERNAL_ERROR",
      message: "Dropship order ops request failed.",
    },
  });
}

function statusForDropshipOrderOpsError(code: string): number {
  switch (code) {
    case "DROPSHIP_ORDER_OPS_LIST_INVALID_INPUT":
    case "DROPSHIP_ORDER_OPS_RETRY_INVALID_INPUT":
    case "DROPSHIP_ORDER_OPS_EXCEPTION_INVALID_INPUT":
    case "DROPSHIP_ORDER_OPS_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND":
      return 404;
    case "DROPSHIP_ORDER_OPS_STATUS_NOT_RETRYABLE":
    case "DROPSHIP_ORDER_OPS_STATUS_NOT_ACTIONABLE":
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
      "DROPSHIP_ORDER_OPS_INVALID_REQUEST",
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
  if (!parsed) {
    return undefined;
  }
  return parsed.split(",").map((status) => status.trim()).filter(Boolean);
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

function parseRequiredBodyString(value: unknown, key: string): string {
  const parsed = parseOptionalBodyString(value);
  if (!parsed) {
    throw new DropshipError(
      "DROPSHIP_ORDER_OPS_INVALID_REQUEST",
      "Required body field is missing.",
      { key },
    );
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_OPS_INVALID_REQUEST",
      "Route parameter must be a positive integer.",
      { key, value },
    );
  }
  return parsed;
}
