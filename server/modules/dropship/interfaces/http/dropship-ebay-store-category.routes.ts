import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import type { DropshipEbayStoreCategoryService } from "../../application/dropship-ebay-store-category-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayStoreCategoryServiceFromEnv } from "../../infrastructure/dropship-ebay-store-category.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { logDropshipRouteFailure } from "./dropship-route-failure-log";

const INTERNAL_ERROR_CODE = "DROPSHIP_EBAY_STORE_CATEGORY_INTERNAL_ERROR";
const HTTP_INTERNAL_ERROR = 500;

export function registerDropshipEbayStoreCategoryRoutes(
  app: Express,
  service: DropshipEbayStoreCategoryService = createDropshipEbayStoreCategoryServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/ebay/store-categories/:storeConnectionId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const result = await service.listForMember(req.session.dropship!.memberId, {
          storeConnectionId: Number(req.params.storeConnectionId),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipEbayStoreCategoryError(req, res, error);
      }
    },
  );
}

function sendDropshipEbayStoreCategoryError(req: Request, res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipEbayStoreCategoryError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: publicDropshipEbayStoreCategoryErrorContext(error.context),
      },
    });
  }
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_EBAY_STORE_CATEGORY_INVALID_INPUT",
        message: "eBay Store category request failed validation.",
        context: { issues: error.issues },
      },
    });
  }
  // An unexpected failure needs a human: one structured ERROR line through the platform logger (CLAUDE.md §10;
  // Listing settings PR 12 verify VS4; it was a raw console line), never the error in the answer.
  const storeConnectionId = Number(req.params.storeConnectionId);
  logDropshipRouteFailure("dropship.ebay_store_categories", req, {
    status: HTTP_INTERNAL_ERROR, code: INTERNAL_ERROR_CODE, error,
    storeConnectionId: Number.isSafeInteger(storeConnectionId) && storeConnectionId > 0 ? storeConnectionId : null,
  });
  return res.status(HTTP_INTERNAL_ERROR).json({
    error: {
      code: INTERNAL_ERROR_CODE,
      message: "eBay Store category request failed.",
    },
  });
}

function publicDropshipEbayStoreCategoryErrorContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const allowedKeys = [
    "storeConnectionId",
    "categoryId",
    "platform",
    "status",
    "providerErrorIds",
    "retryable",
  ] as const;
  const safe = Object.fromEntries(
    allowedKeys
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function statusForDropshipEbayStoreCategoryError(code: string): number {
  switch (code) {
    case "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED":
    case "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE":
    case "DROPSHIP_CREDENTIAL_CHANGED":
    case "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED":
      return 503;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_EBAY_STORE_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
      return 404;
    case "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE":
      return 502;
    default:
      return 500;
  }
}
