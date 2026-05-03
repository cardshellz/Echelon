import type { Express, Response } from "express";
import type { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipListingConfigService } from "../../application/dropship-listing-config-service";
import { replaceDropshipStoreListingConfigInputSchema } from "../../application/dropship-listing-config-dtos";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingConfigServiceFromEnv } from "../../infrastructure/dropship-listing-config.factory";
import {
  requireDropshipAuth,
  requireDropshipSensitiveActionProof,
} from "./dropship-auth.routes";

export function registerDropshipListingConfigRoutes(
  app: Express,
  service: DropshipListingConfigService = createDropshipListingConfigServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/store-connections/:storeConnectionId/listing-config",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const result = await service.getForAdmin(storeConnectionId, {
          actorType: "admin",
          actorId: sessionUserId(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipListingConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/store-connections/:storeConnectionId/listing-config",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const input = parseBody(replaceDropshipStoreListingConfigInputSchema, req.body);
        const result = await service.replaceForAdmin(storeConnectionId, input, {
          actorType: "admin",
          actorId: sessionUserId(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipListingConfigError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/store-connections/:storeConnectionId/listing-config",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const result = await service.getForMember(req.session.dropship!.memberId, storeConnectionId);
        return res.json(result);
      } catch (error) {
        return sendDropshipListingConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/store-connections/:storeConnectionId/listing-config",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("bulk_listing_push"),
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const input = parseBody(replaceDropshipStoreListingConfigInputSchema, req.body);
        const result = await service.replaceForMember(req.session.dropship!.memberId, storeConnectionId, input);
        return res.json(result);
      } catch (error) {
        return sendDropshipListingConfigError(res, error);
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_INVALID_LISTING_CONFIG_REQUEST", "Dropship listing config request failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function sendDropshipListingConfigError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipListingConfigError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipListingConfig] Unexpected listing config error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_LISTING_CONFIG_INTERNAL_ERROR",
      message: "Dropship listing config request failed.",
    },
  });
}

function sessionUserId(req: { session?: { user?: { id?: unknown } } }): string | null {
  const userId = req.session?.user?.id;
  return typeof userId === "string" && userId.trim() ? userId : null;
}

function statusForDropshipListingConfigError(code: string): number {
  switch (code) {
    case "DROPSHIP_INVALID_LISTING_CONFIG_REQUEST":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
      return 404;
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED":
      return 409;
    default:
      return 500;
  }
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_INVALID_LISTING_CONFIG_REQUEST", "Route parameter must be a positive integer.", {
      key,
      value,
    });
  }
  return parsed;
}
