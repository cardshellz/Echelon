import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import type { DropshipEbayStoreCategoryService } from "../../application/dropship-ebay-store-category-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayStoreCategoryServiceFromEnv } from "../../infrastructure/dropship-ebay-store-category.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

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
        return sendDropshipEbayStoreCategoryError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/ebay/store-category-assignments/:productVariantId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const result = await service.replaceForMember(req.session.dropship!.memberId, {
          storeConnectionId: req.body?.storeConnectionId,
          productVariantId: Number(req.params.productVariantId),
          storeCategoryIds: req.body?.storeCategoryIds,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipEbayStoreCategoryError(res, error);
      }
    },
  );
}

function resolveIdempotencyKey(req: Request): string | undefined {
  const candidates = [
    typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : undefined,
    req.header("Idempotency-Key")?.trim(),
    req.header("X-Idempotency-Key")?.trim(),
  ].filter((value): value is string => Boolean(value));
  if (new Set(candidates).size > 1) {
    throw new DropshipError(
      "DROPSHIP_EBAY_STORE_CATEGORY_IDEMPOTENCY_CONFLICT",
      "Conflicting eBay Store category idempotency keys were supplied.",
    );
  }
  return candidates[0];
}

function sendDropshipEbayStoreCategoryError(res: Response, error: unknown): Response {
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
  console.error("[DropshipEbayStoreCategoryRoutes] Unexpected request error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_EBAY_STORE_CATEGORY_INTERNAL_ERROR",
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
    "productVariantId",
    "categoryId",
    "platform",
    "status",
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
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_EBAY_STORE_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case "DROPSHIP_CATALOG_VARIANT_NOT_FOUND":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_EBAY_STORE_CATEGORY_IDEMPOTENCY_CONFLICT":
      return 409;
    case "DROPSHIP_EBAY_STORE_CATEGORY_INVALID":
      return 422;
    case "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE":
      return 502;
    default:
      return 500;
  }
}
