import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError, type z } from "zod";
import { catalogTargetsResponseSchema } from "../../../../../shared/dropship/catalog-scope";
import {
  ebayCategoryBrowseResponseSchema,
  ebayCategoryResponseSchema,
  ebayCategoryRulesReviewSchema,
  ebayCategoryRulesStateSchema,
  ebayCategorySearchResponseSchema,
  saveEbayCategoryRulesResponseSchema,
} from "../../../../../shared/dropship/ebay-category-rules";
import { logger } from "../../../../platform/observability/logger";
import type { DropshipEbayCategoryRulesService } from "../../application/dropship-ebay-category-rules-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipEbayCategoryRulesServiceFromEnv } from "../../infrastructure/dropship-ebay-category-rules.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { parseDropshipBulkJson } from "./dropship-bulk-json.middleware";

type EbayCategoryRulesRouteService = Pick<DropshipEbayCategoryRulesService,
  "getForMember" | "targetsForMember" | "searchForMember" | "browseForMember" | "describeForMember" | "reviewForMember" | "saveForMember">;

/** Rule reads and writes follow the description-template budget. */
const RULES_REQUESTS_PER_MINUTE = 60;
/** Search is typed and debounced in the browser; browsing is one request per click. */
const TAXONOMY_REQUESTS_PER_MINUTE = 120;

export function registerDropshipEbayCategoryRulesRoutes(
  app: Express,
  service: EbayCategoryRulesRouteService = createDropshipEbayCategoryRulesServiceFromEnv(),
): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId";
  const rulesLimiter = memberRateLimit(RULES_REQUESTS_PER_MINUTE, "Too many eBay category rule requests. Try again in a minute.");
  const taxonomyLimiter = memberRateLimit(TAXONOMY_REQUESTS_PER_MINUTE, "Too many eBay category searches. Try again in a minute.");

  app.get(`${base}/ebay-category-rules`, requireDropshipAuth, rulesLimiter, (req, res) => respond(req, res, ebayCategoryRulesStateSchema,
    () => service.getForMember(memberId(req), parseId(req.params.storeConnectionId))));
  app.get(`${base}/ebay-category-rules/targets`, requireDropshipAuth, rulesLimiter, (req, res) => respond(req, res, catalogTargetsResponseSchema,
    () => service.targetsForMember(memberId(req), parseId(req.params.storeConnectionId), {
      type: req.query.type,
      search: req.query.search ?? "",
      page: req.query.page === undefined ? 0 : parseId(String(req.query.page)),
    })));
  app.post(`${base}/ebay-category-rules/review`, requireDropshipAuth, rulesLimiter, parseDropshipBulkJson,
    (req, res) => respond(req, res, ebayCategoryRulesReviewSchema,
      () => service.reviewForMember(memberId(req), parseId(req.params.storeConnectionId), req.body)));
  app.put(`${base}/ebay-category-rules`, requireDropshipAuth, rulesLimiter, parseDropshipBulkJson,
    (req, res) => respond(req, res, saveEbayCategoryRulesResponseSchema,
      () => service.saveForMember(memberId(req), parseId(req.params.storeConnectionId), req.body)));

  // Search is registered before the numeric category route so "search" never reads as an id.
  app.get(`${base}/ebay-categories/search`, requireDropshipAuth, taxonomyLimiter, (req, res) => respond(req, res, ebayCategorySearchResponseSchema,
    () => service.searchForMember(memberId(req), parseId(req.params.storeConnectionId), req.query.q)));
  app.get(`${base}/ebay-categories`, requireDropshipAuth, taxonomyLimiter, (req, res) => respond(req, res, ebayCategoryBrowseResponseSchema,
    () => service.browseForMember(memberId(req), parseId(req.params.storeConnectionId), req.query.parentId)));
  app.get(`${base}/ebay-categories/:categoryId(\\d+)`, requireDropshipAuth, taxonomyLimiter, (req, res) => respond(req, res, ebayCategoryResponseSchema,
    () => service.describeForMember(memberId(req), parseId(req.params.storeConnectionId), req.params.categoryId)));
}

function memberRateLimit(max: number, message: string) {
  return rateLimit({
    windowMs: 60_000,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "DROPSHIP_EBAY_CATEGORY_RATE_LIMITED", message } },
  });
}

function memberId(req: Request): string {
  return req.session.dropship!.memberId;
}

function parseId(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

async function respond<T>(req: Request, res: Response, schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const output = schema.safeParse(await operation());
    if (!output.success) throw new Error("eBay category response failed its contract.");
    return res.json(output.data);
  } catch (error) {
    const status = statusFor(error);
    const code = error instanceof DropshipError
      ? error.code
      : status === 400 ? "DROPSHIP_EBAY_CATEGORY_RULES_INVALID_INPUT" : "DROPSHIP_EBAY_CATEGORY_RULES_INTERNAL_ERROR";
    // eBay or token outages recover on their own (transient); a 500 needs a human (fatal);
    // everything else is a refusal the vendor can fix (permanent).
    const errorClass = status === 502 || status === 503 ? "transient" : status >= 500 ? "fatal" : "permanent";
    const storeConnectionId = parseId(req.params.storeConnectionId ?? "");
    const entry = {
      outcome: "failed",
      error_code: code,
      status,
      method: req.method,
      path: req.route?.path ?? req.path,
      // Correlation: one query on a store or a member returns every refused or failed request.
      store_connection_id: Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null,
      actor_id: req.session?.dropship?.memberId ?? null,
      error_class: errorClass,
      error_message: errorClass === "fatal" && error instanceof Error ? error.message : undefined,
    };
    if (errorClass === "fatal") logger.error("dropship.ebay_category_rules.request_failed", entry);
    else if (errorClass === "transient") logger.warn("dropship.ebay_category_rules.request_failed", entry);
    else logger.info("dropship.ebay_category_rules.request_refused", entry);
    return res.status(status).json({ error: {
      code,
      message: error instanceof DropshipError
        ? error.message
        : status === 400 ? "Check the eBay category request and reload if the page is out of date." : "eBay categories could not be loaded or saved. Please retry.",
      ...(error instanceof DropshipError && publicContext(error.context) ? { context: publicContext(error.context) } : {}),
      ...(error instanceof ZodError ? { context: { issues: error.issues.slice(0, 20) } } : {}),
    } });
  }
}

function statusFor(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (!(error instanceof DropshipError)) return 500;
  switch (error.code) {
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED":
    case "DROPSHIP_EBAY_STORE_REQUIRED":
    case "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED":
    case "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED":
    case "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case "DROPSHIP_EBAY_CATEGORY_NOT_FOUND":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT":
      return 409;
    case "DROPSHIP_EBAY_CATEGORY_RULE_INVALID":
    case "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED":
    case "DROPSHIP_CATALOG_TARGETS_TOO_LARGE":
    case "DROPSHIP_EBAY_CATEGORY_REVIEW_TOO_LARGE":
      return 422;
    case "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE":
    case "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE":
      return 502;
    case "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED":
    case "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE":
    case "DROPSHIP_CREDENTIAL_CHANGED":
    case "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE":
    case "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED":
      return 503;
    default:
      return 500;
  }
}

/** Only identifiers and classifications leave the server; never provider messages or tokens. */
function publicContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const allowed = ["storeConnectionId", "categoryId", "ruleId", "reason", "status", "marketplaceId", "providerErrorIds", "retryable"] as const;
  const safe = Object.fromEntries(allowed.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));
  return Object.keys(safe).length > 0 ? safe : undefined;
}
