import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError, type z } from "zod";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  listingSettingsUpdatedProductsResponseSchema,
} from "../../../../../shared/dropship/listing-settings";
import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionCheckSchema,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { logger } from "../../../../platform/observability/logger";
import type { DropshipListingSettingsService } from "../../application/dropship-listing-settings-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingSettingsService } from "../../infrastructure/dropship-listing-settings.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

type ListingSettingsRouteService = Pick<DropshipListingSettingsService,
  "getSummaryForMember" | "listPricesForMember" | "listProductsForMember" | "listProductIdsForMember" | "getProductForMember"
  | "getProductOwnSettings" | "listCategoriesForMember" | "getCategoryForMember" | "listUpdatedProductsForMember"
  | "getConversionForMember">;

/** Reads only, so the read budget from the Listing settings design (8.8). */
export const LISTING_SETTINGS_READS_PER_MINUTE = 120;
/**
 * The rules conversion's dry run (PR 11, plan D14) loads and plans the whole
 * store on every page and is never cached, so it has its own, smaller budget
 * per member and never spends the read budget the rest of the step shares.
 */
export const LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** The longest `Retry-After` an error may ask for: a minute, the write map's own cap (dropship-listing-setting-write-errors.ts). */
const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Read-only listing settings views (Listing settings design 8.4). No route
 * here writes or calls eBay. Inputs are checked by the service's schemas and
 * every answer by its response schema. One product's view also reads its
 * sizes' stock, and one product's own settings its own row, through the same
 * budget. The rules conversion's dry run (PR 11) has a budget of its own.
 */
export function registerDropshipListingSettingsRoutes(
  app: Express,
  service: ListingSettingsRouteService = createDropshipListingSettingsService(),
): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId/listing-settings";
  // One instance per budget, shared by its routes: memberReadLimit builds a new counter on every call.
  const limiter = memberReadLimit(LISTING_SETTINGS_READS_PER_MINUTE);
  const conversionLimiter = memberReadLimit(LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE);

  app.get(`${base}/summary`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsSummarySchema,
    () => service.getSummaryForMember(memberId(req), { storeConnectionId: parseId(req.params.storeConnectionId) })));
  app.get(`${base}/prices`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsPricesResponseSchema,
    () => service.listPricesForMember(memberId(req), listInput(req))));
  app.get(`${base}/products`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsProductsResponseSchema,
    () => service.listProductsForMember(memberId(req), listInput(req))));
  // Registered before the product route so "ids" never reads as a product id.
  app.get(`${base}/products/ids`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsProductIdsResponseSchema,
    () => service.listProductIdsForMember(memberId(req), productIdsInput(req))));
  app.get(`${base}/products/:productId`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsProductDetailSchema,
    () => service.getProductForMember(memberId(req), {
      storeConnectionId: parseId(req.params.storeConnectionId),
      productId: parseId(req.params.productId),
    })));
  // One product's own settings row, for its editor (PR 10). One segment longer than the product route, so neither
  // route can answer the other's path; "ids" here is not a product id and is refused (400).
  app.get(`${base}/products/:productId/own`, requireDropshipAuth, limiter, (req, res) => respond(req, res,
    listingSettingsProductOwnSettingsSchema, () => service.getProductOwnSettings(memberId(req), {
      storeConnectionId: parseId(req.params.storeConnectionId),
      productId: parseId(req.params.productId),
    })));
  // The Card Shellz categories of the chosen products, and one category's settings (PR 9e); the category save is a write route.
  app.get(`${base}/categories`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsCategoriesResponseSchema,
    () => service.listCategoriesForMember(memberId(req), { storeConnectionId: parseId(req.params.storeConnectionId) })));
  app.get(`${base}/categories/:categoryId`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsCategoryDetailSchema,
    () => service.getCategoryForMember(memberId(req), {
      storeConnectionId: parseId(req.params.storeConnectionId),
      categoryId: parseId(req.params.categoryId),
    })));
  // Card Shellz updated products (PR 9g): moves and own text to check. Its "Got it" is a write route.
  app.get(`${base}/updated-products`, requireDropshipAuth, limiter, (req, res) => respond(req, res,
    listingSettingsUpdatedProductsResponseSchema, () => service.listUpdatedProductsForMember(memberId(req), {
      storeConnectionId: parseId(req.params.storeConnectionId),
      page: queryId(req.query.page),
    })));
  // The rules conversion's dry run (PR 11, plan 4.B.2): read only, on its own budget; a page of its changed sizes.
  app.get(`${base}/conversion`, requireDropshipAuth, conversionLimiter, (req, res) => respond(req, res,
    listingRulesConversionCheckSchema, () => service.getConversionForMember(memberId(req), {
      storeConnectionId: parseId(req.params.storeConnectionId),
      page: queryId(req.query.page),
    })));
}

/** A per-member budget a minute, answered in the read words. */
function memberReadLimit(max: number) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many listing settings requests. Try again in a minute." } },
  });
}

/** Raw query values go to the service's strict schema; a repeated key arrives as an array and is refused there. */
function listInput(req: Request) {
  return {
    storeConnectionId: parseId(req.params.storeConnectionId),
    search: req.query.search,
    show: req.query.show,
    page: queryId(req.query.page),
    ...(req.query.categoryId === undefined ? {} : { categoryId: queryId(req.query.categoryId) }),
  };
}

function productIdsInput(req: Request) {
  return {
    storeConnectionId: parseId(req.params.storeConnectionId),
    search: req.query.search,
    show: req.query.show,
    ...(req.query.categoryId === undefined ? {} : { categoryId: queryId(req.query.categoryId) }),
    ...(req.query.productId === undefined ? {} : { productId: queryId(req.query.productId) }),
  };
}

/** A query number as the schema checks it: digits only, else NaN; a repeated key stays an array for the schema to refuse. */
function queryId(value: unknown): unknown {
  return value === undefined ? undefined : typeof value === "string" ? parseId(value) : value;
}

function memberId(req: Request): string {
  return req.session.dropship!.memberId;
}

/** Shorthand numbers, exponents and partly numeric ids are refused, not parsed. */
function parseId(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

async function respond<T>(req: Request, res: Response, schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const output = schema.safeParse(await operation());
    if (!output.success) throw new Error("Listing settings response failed its contract.");
    return res.json(output.data);
  } catch (error) {
    const status = statusFor(error);
    const code = error instanceof DropshipError
      ? error.code
      : status === 400 ? "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" : "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR";
    const errorClass = errorClassFor(error, status);
    const storeConnectionId = parseId(req.params.storeConnectionId ?? "");
    const productId = parseId(req.params.productId ?? "");
    const categoryId = parseId(req.params.categoryId ?? "");
    const entry = {
      outcome: errorClass === "transient" ? "deferred" : "failed",
      error_code: code,
      status,
      method: req.method,
      path: req.route?.path ?? req.path,
      store_connection_id: Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null,
      product_id: Number.isSafeInteger(productId) ? productId : null,
      ...(Number.isSafeInteger(categoryId) ? { category_id: categoryId } : {}),
      actor_id: req.session?.dropship?.memberId ?? null,
      error_class: errorClass,
      error_message: errorClass === "fatal" && error instanceof Error ? error.message : undefined,
    };
    // A fatal failure needs a human (ERROR); a transient one is retried by the page (WARN); a refusal is the request's (INFO).
    if (errorClass === "fatal") logger.error("dropship.listing_settings.request_failed", entry);
    else if (errorClass === "transient") logger.warn("dropship.listing_settings.request_deferred", entry);
    else logger.info("dropship.listing_settings.request_refused", entry);
    const retryAfter = errorClass === "transient" ? retryAfterSecondsOf(error) : null;
    if (retryAfter !== null) res.setHeader("Retry-After", String(retryAfter));
    return res.status(status).json({ error: {
      code,
      message: error instanceof DropshipError
        ? error.message
        : status === 400 ? "Check the listing settings request and reload if the page is out of date." : "Listing settings could not be loaded. Please retry.",
      ...(error instanceof DropshipError && Number.isSafeInteger(error.context?.storeConnectionId)
        ? { context: { storeConnectionId: error.context?.storeConnectionId } } : {}),
      ...(error instanceof ZodError ? { context: { issues: error.issues.slice(0, 20) } } : {}),
    } });
  }
}

/**
 * A 500 needs a human (fatal), and so does any other 5xx unless its error
 * says it is transient (plan 3.4: the dry run's cost read, a 503); every
 * other answer here is a refusal of this request (permanent). Only a 503 takes
 * its class from the error, so every code answered before PR 11 keeps its class.
 */
function errorClassFor(error: unknown, status: number): "permanent" | "transient" | "fatal" {
  if (status === 503 && error instanceof DropshipError && error.context?.classification === "transient") return "transient";
  return status >= 500 ? "fatal" : "permanent";
}

/**
 * How long a transient failure asks the page to wait: its error's own
 * `context.retryAfterSeconds`, as the write map reads a busy write's
 * (dropship-listing-setting-write-errors.ts), so the code that raises it
 * decides the wait once (the dry run's: CONVERSION_CHECK_RETRY_AFTER_SECONDS).
 * None when the error names no valid wait; the route invents none.
 */
function retryAfterSecondsOf(error: unknown): number | null {
  const value = error instanceof DropshipError ? error.context?.retryAfterSeconds : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_RETRY_AFTER_SECONDS ? value : null;
}

function statusFor(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (!(error instanceof DropshipError)) return 500;
  switch (error.code) {
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND":
    case "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND":
      return 404;
    case "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY":
    case "DROPSHIP_LISTING_SETTINGS_TOO_LARGE":
      return 422;
    case LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable:
      return 503;
    default:
      return 500;
  }
}
