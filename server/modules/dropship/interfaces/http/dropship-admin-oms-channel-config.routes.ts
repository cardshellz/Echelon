import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipOmsChannelConfigService } from "../../application/dropship-oms-channel-config-service";
import { omsChannelConfigValidationError } from "../../application/dropship-oms-channel-config-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipOmsChannelConfigServiceFromEnv } from "../../infrastructure/dropship-oms-channel-config.factory";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminOmsChannelConfigRoutes(
  app: Express,
  service: DropshipOmsChannelConfigService = createDropshipOmsChannelConfigServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/oms-channel-config",
    requirePermission("dropship", "view"),
    async (_req, res) => {
      try {
        const config = await service.getOverview();
        return res.json({ config });
      } catch (error) {
        return sendDropshipOmsChannelConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/oms-channel-config",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.configure({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipOmsChannelConfigError(res, error);
      }
    },
  );
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
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

function sendDropshipOmsChannelConfigError(res: Response, error: unknown): Response {
  const validationError = omsChannelConfigValidationError(error);
  if (validationError) {
    return sendDropshipOmsChannelConfigError(res, validationError);
  }

  if (error instanceof DropshipError) {
    return res.status(statusForDropshipOmsChannelConfigError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminOmsChannelConfigRoutes] Unexpected OMS channel config error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_OMS_CHANNEL_CONFIG_INTERNAL_ERROR",
      message: "Dropship OMS channel configuration request failed.",
    },
  });
}

function statusForDropshipOmsChannelConfigError(code: string): number {
  switch (code) {
    case "DROPSHIP_OMS_CHANNEL_CONFIG_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_OMS_CHANNEL_CONFIG_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_OMS_CHANNEL_NOT_ACTIVE":
      return 409;
    case "DROPSHIP_OMS_CHANNEL_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}
