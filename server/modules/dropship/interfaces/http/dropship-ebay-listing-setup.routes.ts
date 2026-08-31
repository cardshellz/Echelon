import type { Express, Response } from "express";
import type { z } from "zod";
import {
  replaceDropshipEbayListingSetupInputSchema,
  type DropshipEbayListingSetupService,
} from "../../application/dropship-ebay-listing-setup-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayListingSetupServiceFromEnv } from "../../infrastructure/dropship-ebay-listing-setup.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipEbayListingSetupRoutes(
  app: Express,
  service: DropshipEbayListingSetupService = createDropshipEbayListingSetupServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/ebay/listing-setup/:storeConnectionId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId);
        const result = await service.getForMember(
          req.session.dropship!.memberId,
          storeConnectionId,
        );
        return res.json(result);
      } catch (error) {
        return sendDropshipEbayListingSetupError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/ebay/listing-setup/:storeConnectionId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId);
        const input = parseBody(replaceDropshipEbayListingSetupInputSchema, req.body);
        const result = await service.replaceForMember(
          req.session.dropship!.memberId,
          storeConnectionId,
          input,
        );
        return res.json(result);
      } catch (error) {
        return sendDropshipEbayListingSetupError(res, error);
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
      "eBay listing setup request failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
        retryable: false,
      },
    );
  }
  return result.data;
}

function parsePositiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
      "Store connection ID must be a positive integer.",
      { storeConnectionId: value, retryable: false },
    );
  }
  return parsed;
}

function sendDropshipEbayListingSetupError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipEbayListingSetupError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: publicDropshipEbayListingSetupErrorContext(error.context),
      },
    });
  }

  console.error("[DropshipEbayListingSetup] Unexpected eBay listing setup error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR",
      message: "eBay listing setup request failed.",
    },
  });
}

function publicDropshipEbayListingSetupErrorContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const allowedKeys = [
    "storeConnectionId",
    "platform",
    "resource",
    "status",
    "retryable",
    "invalidFields",
    "issues",
  ] as const;
  const safe = Object.fromEntries(
    allowedKeys
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function statusForDropshipEbayListingSetupError(code: string): number {
  switch (code) {
    case "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT":
    case "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED":
    case "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
      return 404;
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED":
    case "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED":
    case "DROPSHIP_EBAY_LISTING_SETUP_STORE_REQUIRED":
      return 409;
    case "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE":
    case "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE":
      return 502;
    default:
      return 500;
  }
}
