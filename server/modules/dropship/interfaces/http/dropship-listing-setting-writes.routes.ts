import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { z } from "zod";
import {
  LISTING_SETTING_WRITE_ERROR_CODES,
  acknowledgeCategoryMovesResponseSchema,
  applyPriceChangesResponseSchema,
  priceChangeReviewIdSchema,
  priceChangeReviewResponseSchema,
  saveCategorySettingsResponseSchema,
  saveProductSettingsResponseSchema,
  saveProductsBulkResponseSchema,
  saveSizePricesResponseSchema,
} from "../../../../../shared/dropship/listing-setting-writes";
import { listingRulesConversionApplyResponseSchema } from "../../../../../shared/dropship/listing-rules-conversion";
import { logger } from "../../../../platform/observability/logger";
import {
  createDropshipListingSettingWriteServices,
  type ListingSettingWriteServices,
} from "../../infrastructure/dropship-listing-setting-writes.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { LISTING_SETTINGS_TOO_LARGE_MESSAGE, parseDropshipBulkJsonFor } from "./dropship-bulk-json.middleware";
import { listingSettingWriteErrorAnswer } from "./dropship-listing-setting-write-errors";

/**
 * The listing-settings writes (Listing settings design 8.5; plan PR 9). Reads
 * stay in dropship-listing-settings.routes.ts, which has no write dependency.
 * Every route: sign-in, its member budget, then the 1 MiB parser, so no
 * anonymous or over-budget caller makes the server parse a large body; the
 * rules conversion's apply has a small body and keeps the global 100 KB
 * parser. Routes orchestrate only: the services check, write and log each save.
 */

/** Bulk writes and price checks share one budget per member (design 8.8). */
export const LISTING_SETTING_BULK_WRITES_PER_MINUTE = 30;
/** Single writes (one product, one category, "Got it") share another (design 8.8; plan P7). */
export const LISTING_SETTING_SINGLE_WRITES_PER_MINUTE = 60;
/**
 * A price check's pages are reads, on their own budget in this router (plan
 * P7: the page needs the write repository, so it cannot share the read
 * router's instance without coupling the routers). The read router's 120.
 */
export const LISTING_SETTING_REVIEW_PAGE_READS_PER_MINUTE = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** The words of a write over its budget. */
const WRITE_RATE_LIMIT_MESSAGE = "Too many saves in a minute. Wait a moment and try again.";
/** The read router's words, for the price check's pages (plan 3.5). */
const READ_RATE_LIMIT_MESSAGE = "Too many listing settings requests. Try again in a minute.";
/** W7's POSTs name their category and review in the body, not the path (plan 9.4): the refusal line takes them from there. */
const W7_BODY_IDS = { logBodyIds: true } as const;

export function registerDropshipListingSettingWritesRoutes(
  app: Express,
  services: ListingSettingWriteServices = createDropshipListingSettingWriteServices(),
): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId/listing-settings";
  // One instance per budget, shared by its routes: memberRateLimit builds a new counter on every call.
  const bulkLimiter = memberRateLimit(LISTING_SETTING_BULK_WRITES_PER_MINUTE);
  const singleLimiter = memberRateLimit(LISTING_SETTING_SINGLE_WRITES_PER_MINUTE);
  const reviewPageLimiter = memberRateLimit(LISTING_SETTING_REVIEW_PAGE_READS_PER_MINUTE, READ_RATE_LIMIT_MESSAGE);
  const parseBody = parseDropshipBulkJsonFor(LISTING_SETTINGS_TOO_LARGE_MESSAGE);

  app.put(`${base}/size-prices`, requireDropshipAuth, bulkLimiter, parseBody, (req, res) => respond(req, res, saveSizePricesResponseSchema,
    () => services.sizePrices.saveForMember(memberId(req), parseId(req.params.storeConnectionId), req.body)));
  app.put(`${base}/products/:productId`, requireDropshipAuth, singleLimiter, parseBody, (req, res) => respond(req, res,
    saveProductSettingsResponseSchema, () => services.products.saveForMember(memberId(req), parseId(req.params.storeConnectionId),
      parseId(req.params.productId), req.body)));
  // A heavy write (plan 3.10): the bulk budget here; the service's heavy-write gate wraps its write transaction.
  app.post(`${base}/products/bulk`, requireDropshipAuth, bulkLimiter, parseBody, (req, res) => respond(req, res,
    saveProductsBulkResponseSchema, () => services.products.saveBulkForMember(memberId(req), parseId(req.params.storeConnectionId), req.body)));
  // One category is a single write; with "Also clear theirs" the service's heavy-write gate wraps its transaction.
  app.put(`${base}/categories/:categoryId`, requireDropshipAuth, singleLimiter, parseBody, (req, res) => respond(req, res,
    saveCategorySettingsResponseSchema, () => services.categories.saveForMember(memberId(req), parseId(req.params.storeConnectionId),
      parseId(req.params.categoryId), req.body)));
  // W7 (plan 9.4). The check and the apply are heavy writes on the bulk budget; the service's heavy-write gate wraps each
  // transaction. A page is a read: its own budget, no body, no gate.
  app.post(`${base}/price-changes/review`, requireDropshipAuth, bulkLimiter, parseBody, (req, res) => respond(req, res,
    priceChangeReviewResponseSchema, () => services.priceChanges.reviewForMember(memberId(req), parseId(req.params.storeConnectionId), req.body),
    W7_BODY_IDS));
  app.get(`${base}/price-changes/reviews/:reviewId`, requireDropshipAuth, reviewPageLimiter, (req, res) => respond(req, res,
    priceChangeReviewResponseSchema, () => services.priceChanges.reviewPageForMember(memberId(req), parseId(req.params.storeConnectionId),
      req.params.reviewId, parsePage(req.query.page))));
  app.post(`${base}/price-changes/apply`, requireDropshipAuth, bulkLimiter, parseBody, (req, res) => respond(req, res,
    applyPriceChangesResponseSchema, () => services.priceChanges.applyForMember(memberId(req), parseId(req.params.storeConnectionId), req.body),
    W7_BODY_IDS));
  // W13 (plan 10.3): one vendor action ("Got it", or "Got it for all N" with up to 10,000 products), so the single
  // budget it shares with W5 and W12 (plan P7); the 1 MiB parser, as a 10,000-item body is about 530 KB.
  app.post(`${base}/category-moves/acknowledge`, requireDropshipAuth, singleLimiter, parseBody, (req, res) => respond(req, res,
    acknowledgeCategoryMovesResponseSchema, () => services.categoryMoves.acknowledgeForMember(memberId(req),
      parseId(req.params.storeConnectionId), req.body)));
  // W11's vendor apply (PR 11, plan 7.B.2): a heavy write on the bulk budget, its transaction behind the service's
  // heavy-write gate. Its body is a key and two hashes, so it keeps the global parser and is not in the 1 MiB table.
  app.post(`${base}/conversion/apply`, requireDropshipAuth, bulkLimiter, (req, res) => respond(req, res,
    listingRulesConversionApplyResponseSchema, () => services.conversion.applyForMember(memberId(req),
      parseId(req.params.storeConnectionId), req.body)));
}

/** One budget per call: build each once and share it (plan 3.5). The words are the write's unless a read's are given. */
function memberRateLimit(max: number, message: string = WRITE_RATE_LIMIT_MESSAGE) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: LISTING_SETTING_WRITE_ERROR_CODES.rateLimited, message } },
  });
}

function memberId(req: Request): string {
  return req.session.dropship!.memberId;
}

/** Shorthand numbers, exponents and partly numeric ids are refused by the service's schema, not parsed. */
function parseId(value: string | undefined): number {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/** A page number as W1 parses it (dropship-pricing-rules.routes.ts): absent is page 0; anything but digits is refused by the service. */
function parsePage(value: unknown): number {
  return value === undefined ? 0 : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * A body's id for the refusal log line only, never for a decision (the
 * service parses the body): a positive whole number, else NaN, so a value
 * out of its contract is left out of the line rather than logged as sent.
 */
function bodyWholeNumber(body: unknown, key: string): number {
  const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

/** The apply's review id for the log line only: the server's own lowercase form (the apply's schema), else null. */
function bodyReviewId(body: unknown): string | null {
  const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>).reviewId : undefined;
  const parsed = priceChangeReviewIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function respond<T>(req: Request, res: Response, schema: z.ZodType<T>, operation: () => Promise<unknown>,
  options: { logBodyIds?: boolean } = {}): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const output = schema.safeParse(await operation());
    // After a commit: the save stands; the answer itself is the fault (500, "We couldn't confirm your save").
    if (!output.success) throw new Error("Listing settings write response failed its contract.");
    return res.json(output.data);
  } catch (error) {
    const answer = listingSettingWriteErrorAnswer(error);
    const storeConnectionId = parseId(req.params.storeConnectionId);
    const productId = parseId(req.params.productId);
    const categoryId = options.logBodyIds === true ? bodyWholeNumber(req.body, "categoryId") : parseId(req.params.categoryId);
    const reviewId = options.logBodyIds === true ? bodyReviewId(req.body)
      : typeof req.params.reviewId === "string" ? req.params.reviewId : null;
    const entry = {
      outcome: answer.errorClass === "transient" ? "deferred" : answer.errorClass === "fatal" ? "failed" : "refused",
      error_code: answer.code,
      error_class: answer.errorClass,
      status: answer.status,
      method: req.method,
      path: req.route?.path ?? req.path,
      // Correlation: one query on a store, product, category, review or member returns every refused or failed write.
      store_connection_id: Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null,
      ...(Number.isSafeInteger(productId) ? { product_id: productId } : {}),
      ...(Number.isSafeInteger(categoryId) ? { category_id: categoryId } : {}),
      ...(reviewId === null ? {} : { review_id: reviewId }),
      actor_id: req.session?.dropship?.memberId ?? null,
    };
    // Expected refusals are DEBUG; a retryable failure is WARN; a broken contract needs a human (ERROR).
    if (answer.errorClass === "fatal") {
      logger.error("dropship.listing_settings.write_failed", {
        ...entry, error_message: answer.internalMessage, error_context: answer.internalContext,
      });
    } else if (answer.errorClass === "transient") {
      logger.warn("dropship.listing_settings.write_deferred", entry);
    } else {
      logger.debug("dropship.listing_settings.write_refused", entry);
    }
    if (answer.retryAfterSeconds !== null) res.setHeader("Retry-After", String(answer.retryAfterSeconds));
    return res.status(answer.status).json(answer.body);
  }
}
