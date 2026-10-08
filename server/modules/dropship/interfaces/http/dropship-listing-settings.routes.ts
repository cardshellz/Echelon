import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError, type z } from "zod";
import {
  listingSettingsPricesResponseSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
} from "../../../../../shared/dropship/listing-settings";
import { logger } from "../../../../platform/observability/logger";
import type { DropshipListingSettingsService } from "../../application/dropship-listing-settings-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingSettingsService } from "../../infrastructure/dropship-listing-settings.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

type ListingSettingsRouteService = Pick<DropshipListingSettingsService,
  "getSummaryForMember" | "listPricesForMember" | "listProductsForMember">;

/** Reads only, so the read budget from the Listing settings design (8.8). */
export const LISTING_SETTINGS_READS_PER_MINUTE = 120;

/**
 * Read-only listing settings views (Listing settings design 8.4). No route
 * here writes or calls eBay. Inputs are checked by the service's schemas and
 * every answer by its response schema.
 */
export function registerDropshipListingSettingsRoutes(
  app: Express,
  service: ListingSettingsRouteService = createDropshipListingSettingsService(),
): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId/listing-settings";
  const limiter = rateLimit({
    windowMs: 60_000,
    max: LISTING_SETTINGS_READS_PER_MINUTE,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many listing settings requests. Try again in a minute." } },
  });

  app.get(`${base}/summary`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsSummarySchema,
    () => service.getSummaryForMember(memberId(req), { storeConnectionId: parseId(req.params.storeConnectionId) })));
  app.get(`${base}/prices`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsPricesResponseSchema,
    () => service.listPricesForMember(memberId(req), listInput(req))));
  app.get(`${base}/products`, requireDropshipAuth, limiter, (req, res) => respond(req, res, listingSettingsProductsResponseSchema,
    () => service.listProductsForMember(memberId(req), listInput(req))));
}

/** Raw query values go to the service's strict schema; a repeated key arrives as an array and is refused there. */
function listInput(req: Request) {
  return {
    storeConnectionId: parseId(req.params.storeConnectionId),
    search: req.query.search,
    show: req.query.show,
    page: req.query.page === undefined ? undefined : typeof req.query.page === "string" ? parseId(req.query.page) : req.query.page,
  };
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
    // A 500 needs a human (fatal); every other answer here is a refusal of this request (permanent).
    const errorClass = status >= 500 ? "fatal" : "permanent";
    const storeConnectionId = parseId(req.params.storeConnectionId ?? "");
    const entry = {
      outcome: "failed",
      error_code: code,
      status,
      method: req.method,
      path: req.route?.path ?? req.path,
      store_connection_id: Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null,
      actor_id: req.session?.dropship?.memberId ?? null,
      error_class: errorClass,
      error_message: errorClass === "fatal" && error instanceof Error ? error.message : undefined,
    };
    if (errorClass === "fatal") logger.error("dropship.listing_settings.request_failed", entry);
    else logger.info("dropship.listing_settings.request_refused", entry);
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

function statusFor(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (!(error instanceof DropshipError)) return 500;
  switch (error.code) {
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
      return 404;
    case "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY":
    case "DROPSHIP_LISTING_SETTINGS_TOO_LARGE":
      return 422;
    default:
      return 500;
  }
}
