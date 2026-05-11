import type { Express, Request, Response } from "express";
import type { SafeUser } from "@shared/schema";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipWorkerOpsService,
  DropshipWorkerSweepName,
} from "../../application/dropship-worker-ops-service";
import { createDropshipWorkerOpsServiceFromEnv } from "../../infrastructure/dropship-worker-ops.factory";

export function registerDropshipAdminWorkerOpsRoutes(
  app: Express,
  service: DropshipWorkerOpsService = createDropshipWorkerOpsServiceFromEnv(),
): void {
  app.post(
    "/api/dropship/admin/worker-sweeps/:worker/run",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.runSweep({
          worker: parseWorkerName(req.params.worker),
          batchSize: parseOptionalPositiveInteger(req.body?.batchSize, "batchSize"),
          reason: parseOptionalBodyString(req.body?.reason),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipWorkerOpsError(res, error);
      }
    },
  );
}

function parseWorkerName(value: unknown): DropshipWorkerSweepName {
  if (value === "listing_push" || value === "order_processing" || value === "ebay_order_intake") {
    return value;
  }
  throw new DropshipError(
    "DROPSHIP_WORKER_SWEEP_INVALID_REQUEST",
    "Dropship worker sweep name is invalid.",
    { worker: value },
  );
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_WORKER_SWEEP_INVALID_REQUEST",
      `${field} must be a positive integer.`,
      { field, value },
    );
  }
  return parsed;
}

function parseOptionalBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_WORKER_SWEEP_INVALID_REQUEST",
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

function sessionUser(req: Request): SafeUser | null {
  const session = req.session as { user?: SafeUser } | undefined;
  const candidate = session?.user;
  return candidate?.id ? candidate : null;
}

function sendDropshipWorkerOpsError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipWorkerOpsError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminWorkerOpsRoutes] Unexpected worker ops error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_WORKER_SWEEP_INTERNAL_ERROR",
      message: "Dropship worker sweep failed.",
    },
  });
}

function statusForDropshipWorkerOpsError(code: string): number {
  switch (code) {
    case "DROPSHIP_WORKER_SWEEP_INVALID_INPUT":
    case "DROPSHIP_WORKER_SWEEP_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_WORKER_SWEEP_NOT_CONFIGURED":
      return 503;
    default:
      return 500;
  }
}
