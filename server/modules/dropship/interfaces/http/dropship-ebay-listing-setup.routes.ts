import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import type { z } from "zod";
import {
  repairDropshipEbayShipFromInputSchema,
  replaceDropshipEbayListingSetupInputSchema,
  type DropshipEbayListingSetupService,
} from "../../application/dropship-ebay-listing-setup-service";
import { dropshipListingConfigReadOnlyError } from "../../application/dropship-listing-config-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayListingSetupServiceFromEnv } from "../../infrastructure/dropship-ebay-listing-setup.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

/** Single writes, per member (Listing settings design 8.8). */
export const LISTING_SETUP_WRITES_PER_MINUTE = 60;

type ListingSetupRouteService = Pick<
  DropshipEbayListingSetupService,
  "getViewForMember" | "replaceForMember" | "repairShipFromForMember"
>;

export function registerDropshipEbayListingSetupRoutes(
  app: Express,
  service: ListingSetupRouteService = createDropshipEbayListingSetupServiceFromEnv(),
): void {
  const base = "/api/dropship/ebay/listing-setup/:storeConnectionId";
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: LISTING_SETUP_WRITES_PER_MINUTE,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED",
        message: "Too many saves in a minute. Wait a moment and try again.",
      },
    },
  });

  app.get(base, requireDropshipAuth, async (req, res) => {
    try {
      const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId);
      const result = await service.getViewForMember(req.session.dropship!.memberId, storeConnectionId);
      if (!acceptsListingSetupContract(req.get(LISTING_SETUP_CONTRACT_HEADER))) {
        const legacy = legacyListingSetupRefusal(result);
        if (legacy) return sendDropshipEbayListingSetupError(res, legacy);
      }
      return res.json(result);
    } catch (error) {
      return sendDropshipEbayListingSetupError(res, error);
    }
  });

  app.put(base, requireDropshipAuth, writeLimiter, async (req, res) => {
    try {
      const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId);
      const input = parseBody(replaceDropshipEbayListingSetupInputSchema, req.body);
      const result = await service.replaceForMember(req.session.dropship!.memberId, storeConnectionId, input);
      return res.json(result);
    } catch (error) {
      return sendDropshipEbayListingSetupError(res, error);
    }
  });

  // W10: the ship-from repair. It lives with the setup routes, not under the
  // read-only listing-settings views, because it calls eBay and writes.
  app.post(`${base}/ship-from/repair`, requireDropshipAuth, writeLimiter, async (req, res) => {
    try {
      const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId);
      const input = parseBody(repairDropshipEbayShipFromInputSchema, req.body);
      const result = await service.repairShipFromForMember(req.session.dropship!.memberId, storeConnectionId, input);
      return res.json(result);
    } catch (error) {
      return sendDropshipEbayListingSetupError(res, error);
    }
  });
}

/**
 * Pages built with this release send this header on the setup read. A page
 * loaded before it (an old browser tab) does not, and cannot show a read-only
 * view or a missing shipping check: it reads fulfillmentCapability without a
 * null check. Such a page gets the error it got before for those states,
 * until it is reloaded.
 */
export const LISTING_SETUP_CONTRACT_HEADER = "X-Dropship-Listing-Setup-Contract";
const LISTING_SETUP_CONTRACT_VERSION = "2";

function acceptsListingSetupContract(value: string | undefined): boolean {
  return value?.trim() === LISTING_SETUP_CONTRACT_VERSION;
}

/** The pre-release answer for a read-only view or an unreadable Card Shellz shipping check; null when the view is fine for any page. */
function legacyListingSetupRefusal(
  result: Awaited<ReturnType<ListingSetupRouteService["getViewForMember"]>>,
): DropshipError | null {
  if (!result.access.canEdit) {
    return dropshipListingConfigReadOnlyError(result.access.reason, { storeConnectionId: result.storeConnectionId });
  }
  if (result.checks.fulfillment.status === "unavailable") {
    return new DropshipError(
      result.checks.fulfillment.reference,
      "eBay listing setup is unavailable.",
      { storeConnectionId: result.storeConnectionId, retryable: result.checks.fulfillment.kind === "temporary" },
    );
  }
  return null;
}

/** Request fields a page loaded before this release does not send; it must reload rather than save blind. */
const RELOAD_REQUIRED_FIELDS: ReadonlySet<string> = new Set(["expectedRevision", "idempotencyKey"]);

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const missingVersion = result.error.issues.some((issue) => issue.code === "invalid_type"
      && issue.received === "undefined"
      && RELOAD_REQUIRED_FIELDS.has(String(issue.path[0])));
    if (missingVersion) {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
        "Reload this page to load the latest store settings, then save again.",
        { retryable: false },
      );
    }
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
    "providerErrorIds",
    "diagnosticReference",
    "attempts",
    "retryable",
    "invalidFields",
    "issues",
    "fulfillmentPolicyId",
    "originWarehouseId",
    "serviceLevelId",
    "expectedServiceLevelId",
    "returnedServiceLevelId",
    "routingCode",
    "routingRevision",
    "field",
    "country",
    "expectedRevision",
    "currentRevision",
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
    case "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED":
    case "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE":
    case "DROPSHIP_CREDENTIAL_CHANGED":
    case "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED":
      return 503;
    case "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_INPUT":
    case "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID":
    case "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID":
      return 400;
    // A page loaded before this release: precondition (the revision) missing.
    case "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED":
      return 428;
    case "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE":
      return 422;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED":
    case "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED":
    case "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
      return 404;
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED":
    case "DROPSHIP_LISTING_CONFIG_STORE_PAUSED":
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING":
    case "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE":
    // The store was paused or disconnected while this request reached eBay.
    case "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED":
    case "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT":
    case "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT":
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
    case "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_COUNTRY_UNSUPPORTED":
      return 409;
    case "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE":
      return 503;
    case "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE":
    case "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE":
    case "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE":
    case "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE":
      return 502;
    default:
      return 500;
  }
}
