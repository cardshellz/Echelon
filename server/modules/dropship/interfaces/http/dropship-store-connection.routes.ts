import type { Express, Response } from "express";
import type { z } from "zod";
import {
  type DropshipStoreConnectionService,
} from "../../application/dropship-store-connection-service";
import {
  completeDropshipStoreConnectionOAuthInputSchema,
  disconnectDropshipStoreConnectionInputSchema,
  startDropshipStoreConnectionOAuthInputSchema,
} from "../../application/dropship-store-connection-dtos";
import { DropshipError } from "../../domain/errors";
import { createDropshipStoreConnectionServiceFromEnv } from "../../infrastructure/dropship-store-connection.factory";
import {
  requireDropshipAuth,
  requireDropshipSensitiveActionProof,
} from "./dropship-auth.routes";

const DROPSHIP_PORTAL_URL = process.env.DROPSHIP_PORTAL_URL || "https://cardshellz.io";

export function registerDropshipStoreConnectionRoutes(
  app: Express,
  service: DropshipStoreConnectionService = createDropshipStoreConnectionServiceFromEnv(),
): void {
  app.get("/api/dropship/store-connections", requireDropshipAuth, async (req, res) => {
    try {
      const result = await service.listForMember(req.session.dropship!.memberId);
      return res.json(result);
    } catch (error) {
      return sendDropshipStoreConnectionError(res, error);
    }
  });

  app.post(
    "/api/dropship/store-connections/oauth/start",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("connect_store"),
    async (req, res) => {
      try {
        const input = parseBody(startDropshipStoreConnectionOAuthInputSchema, req.body);
        const result = await service.startOAuth(req.session.dropship!.memberId, input);
        return res.status(202).json(result);
      } catch (error) {
        return sendDropshipStoreConnectionError(res, error);
      }
    },
  );

  app.get("/api/dropship/store-connections/oauth/callback", async (req, res) => {
    try {
      const input = completeDropshipStoreConnectionOAuthInputSchema.parse({
        platform: optionalQueryString(req.query.platform),
        code: optionalQueryString(req.query.code),
        state: requiredQueryString(req.query.state, "state"),
        error: optionalQueryString(req.query.error),
        shop: optionalQueryString(req.query.shop),
        hmac: optionalQueryString(req.query.hmac),
      });
      const result = await service.completeOAuthCallback(input);
      return res.redirect(buildPortalRedirect("connected", result.returnTo));
    } catch (error) {
      const code = error instanceof DropshipError ? error.code : "DROPSHIP_STORE_CONNECTION_INTERNAL_ERROR";
      return res.redirect(buildPortalRedirect("error", null, code));
    }
  });

  app.post(
    "/api/dropship/store-connections/:storeConnectionId/disconnect",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("disconnect_store"),
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const input = parseBody(disconnectDropshipStoreConnectionInputSchema, req.body);
        const connection = await service.disconnect(req.session.dropship!.memberId, storeConnectionId, input);
        return res.json({ connection });
      } catch (error) {
        return sendDropshipStoreConnectionError(res, error);
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_INVALID_STORE_CONNECTION_REQUEST", "Dropship store connection request failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function sendDropshipStoreConnectionError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipStoreConnectionError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipStoreConnection] Unexpected store connection error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_STORE_CONNECTION_INTERNAL_ERROR",
      message: "Dropship store connection request failed.",
    },
  });
}

function statusForDropshipStoreConnectionError(code: string): number {
  switch (code) {
    case "DROPSHIP_INVALID_STORE_CONNECTION_REQUEST":
    case "DROPSHIP_STORE_PLATFORM_UNSUPPORTED":
    case "DROPSHIP_SHOP_DOMAIN_REQUIRED":
    case "DROPSHIP_INVALID_SHOP_DOMAIN":
    case "DROPSHIP_STORE_OAUTH_CODE_REQUIRED":
    case "DROPSHIP_INVALID_OAUTH_STATE":
    case "DROPSHIP_STORE_OAUTH_STATE_MISMATCH":
    case "DROPSHIP_SHOPIFY_HMAC_INVALID":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_VENDOR_NOT_CONNECTABLE":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
      return 404;
    case "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED":
      return 409;
    case "DROPSHIP_OAUTH_STATE_EXPIRED":
      return 410;
    case "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED":
    case "DROPSHIP_SHOPIFY_OAUTH_NOT_CONFIGURED":
    case "DROPSHIP_OAUTH_STATE_SECRET_REQUIRED":
    case "DROPSHIP_TOKEN_VAULT_NOT_CONFIGURED":
    case "DROPSHIP_TOKEN_KEY_INVALID":
    case "DROPSHIP_EBAY_TOKEN_EXCHANGE_FAILED":
    case "DROPSHIP_SHOPIFY_TOKEN_EXCHANGE_FAILED":
      return 503;
    default:
      return 500;
  }
}

function requiredQueryString(value: unknown, key: string): string {
  const normalized = optionalQueryString(value);
  if (!normalized) {
    throw new DropshipError("DROPSHIP_INVALID_STORE_CONNECTION_REQUEST", "Required query parameter is missing.", { key });
  }
  return normalized;
}

function optionalQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_INVALID_STORE_CONNECTION_REQUEST", "Route parameter must be a positive integer.", {
      key,
      value,
    });
  }
  return parsed;
}

function buildPortalRedirect(status: "connected" | "error", returnTo: string | null, errorCode?: string): string {
  const url = new URL(returnTo || "/dropship/settings", DROPSHIP_PORTAL_URL);
  url.searchParams.set("storeConnection", status);
  if (errorCode) {
    url.searchParams.set("error", errorCode);
  }
  return url.toString();
}
