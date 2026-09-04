import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import {
  ebayOAuthBrandingValidationError,
  type DropshipEbayOAuthBrandingService,
} from "../../application/dropship-ebay-oauth-branding-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayOAuthBrandingServiceFromEnv } from "../../infrastructure/dropship-ebay-oauth-branding.factory";

const BRANDING_URL =
  "/api/dropship/admin/integrations/ebay/oauth-branding";

type EbayOAuthBrandingRouteService = Pick<
  DropshipEbayOAuthBrandingService,
  | "getConfiguration"
  | "requestCustomerFacingAppName"
  | "confirmExternalUpdate"
>;

type SessionUser = {
  id: string;
};

export function registerDropshipAdminEbayOAuthBrandingRoutes(
  app: Express,
  service: EbayOAuthBrandingRouteService =
    createDropshipEbayOAuthBrandingServiceFromEnv(),
): void {
  app.get(
    BRANDING_URL,
    requirePermission("dropship", "view"),
    async (_req, res) => {
      try {
        return res.json({ configuration: await service.getConfiguration() });
      } catch (error) {
        return sendEbayOAuthBrandingError(res, error);
      }
    },
  );

  app.put(
    BRANDING_URL,
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.requestCustomerFacingAppName({
          ...requestBody(req),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendEbayOAuthBrandingError(res, error);
      }
    },
  );

  app.post(
    `${BRANDING_URL}/external-update-verification`,
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.confirmExternalUpdate({
          ...requestBody(req),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendEbayOAuthBrandingError(res, error);
      }
    },
  );
}

function requestBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

function resolveIdempotencyKey(req: Request): string {
  const body = requestBody(req);
  const header =
    req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey =
    typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function adminActor(req: Request): {
  actorType: "admin";
  actorId?: string;
} {
  return {
    actorType: "admin",
    actorId: sessionUser(req)?.id,
  };
}

function sessionUser(req: Request): SessionUser | null {
  const candidate = req.session?.user as SessionUser | undefined;
  return candidate?.id ? candidate : null;
}

function sendEbayOAuthBrandingError(
  res: Response,
  error: unknown,
): Response {
  const validationError = ebayOAuthBrandingValidationError(error);
  if (validationError) {
    return sendEbayOAuthBrandingError(res, validationError);
  }

  if (error instanceof DropshipError) {
    return res.status(statusForEbayOAuthBrandingError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error(
    "[DropshipAdminEbayOAuthBrandingRoutes] Unexpected connection-branding error:",
    error,
  );
  return res.status(500).json({
    error: {
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_INTERNAL_ERROR",
      message: "eBay connection-branding request failed.",
    },
  });
}

function statusForEbayOAuthBrandingError(code: string): number {
  switch (code) {
    case "DROPSHIP_EBAY_OAUTH_BRANDING_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_EBAY_OAUTH_BRANDING_NOT_FOUND":
      return 404;
    case "DROPSHIP_EBAY_OAUTH_BRANDING_REVISION_CONFLICT":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_COMMAND_INCOMPLETE":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_UNCHANGED":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_NOT_PENDING":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_DEDICATED_RUNAME_REQUIRED":
    case "DROPSHIP_EBAY_OAUTH_BRANDING_CONFIGURATION_REQUIRED":
      return 409;
    default:
      return 500;
  }
}
