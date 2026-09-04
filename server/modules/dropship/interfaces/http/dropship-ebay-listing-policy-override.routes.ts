import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import type { DropshipEbayListingPolicyOverrideService } from "../../application/dropship-ebay-listing-policy-override-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayListingPolicyOverrideServiceFromEnv } from "../../infrastructure/dropship-ebay-listing-policy-override.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipEbayListingPolicyOverrideRoutes(
  app: Express,
  service: DropshipEbayListingPolicyOverrideService = createDropshipEbayListingPolicyOverrideServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/ebay/listing-policy-overrides/:storeConnectionId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const result = await service.listForMember(req.session.dropship!.memberId, {
          storeConnectionId: Number(req.params.storeConnectionId),
        });
        return res.json(result);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/ebay/listing-policy-overrides/bulk",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const result = await service.replaceManyForMember(req.session.dropship!.memberId, {
          storeConnectionId: req.body?.storeConnectionId,
          assignments: req.body?.assignments,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/ebay/listing-policy-overrides/:productVariantId",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const result = await service.replaceForMember(req.session.dropship!.memberId, {
          storeConnectionId: req.body?.storeConnectionId,
          productVariantId: Number(req.params.productVariantId),
          expectedRevisionId: req.body?.expectedRevisionId ?? null,
          fulfillmentPolicyId: req.body?.fulfillmentPolicyId,
          returnPolicyId: req.body?.returnPolicyId,
          paymentPolicyId: req.body?.paymentPolicyId,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error);
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
      "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_IDEMPOTENCY_CONFLICT",
      "Conflicting eBay listing policy override idempotency keys were supplied.",
    );
  }
  return candidates[0];
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: publicContext(error.context),
      },
    });
  }
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID_INPUT",
        message: "eBay listing policy override request failed validation.",
        context: { issues: error.issues },
      },
    });
  }
  console.error("[DropshipEbayListingPolicyOverrideRoutes] Unexpected request error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INTERNAL_ERROR",
      message: "eBay listing policy override request failed.",
    },
  });
}

function publicContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const allowedKeys = [
    "storeConnectionId",
    "productVariantId",
    "expectedRevisionId",
    "actualRevisionId",
    "platform",
    "resource",
    "status",
    "invalidFields",
    "issues",
    "fulfillmentPolicyId",
    "serviceLevelId",
    "expectedServiceLevelId",
    "returnedServiceLevelId",
    "routingCode",
    "routingRevision",
    "retryable",
  ] as const;
  const safe = Object.fromEntries(
    allowedKeys
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function statusForError(code: string): number {
  switch (code) {
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED":
    case "DROPSHIP_EBAY_STORE_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED":
    case "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
    case "DROPSHIP_CATALOG_VARIANT_NOT_FOUND":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT":
    case "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_REPLAY_INCOMPLETE":
      return 409;
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED":
    case "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED":
    case "DROPSHIP_EBAY_LISTING_SETUP_STORE_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED":
    case "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_ROUTING_MISMATCH":
    case "DROPSHIP_EBAY_FULFILLMENT_WAREHOUSE_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_SLA_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK":
    case "DROPSHIP_EBAY_FULFILLMENT_AMBIGUOUS_RATE_BOOK":
    case "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED":
    case "DROPSHIP_EBAY_FULFILLMENT_DESTINATION_COVERAGE_REQUIRED":
      return 409;
    case "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE":
      return 503;
    case "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID":
      return 422;
    case "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE":
    case "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE":
    case "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE":
      return 502;
    default:
      return 500;
  }
}
