import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { z } from "zod";
import { LISTING_SETTING_WRITE_ERROR_CODES, saveSizePricesResponseSchema } from "../../../../../shared/dropship/listing-setting-writes";
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
 * anonymous or over-budget caller makes the server parse a large body. Routes
 * orchestrate only: the services check, write and log each save.
 */

/** Bulk writes and price checks share one budget per member (design 8.8). */
export const LISTING_SETTING_BULK_WRITES_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function registerDropshipListingSettingWritesRoutes(
  app: Express,
  services: ListingSettingWriteServices = createDropshipListingSettingWriteServices(),
): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId/listing-settings";
  const bulkLimiter = memberRateLimit(LISTING_SETTING_BULK_WRITES_PER_MINUTE);
  const parseBody = parseDropshipBulkJsonFor(LISTING_SETTINGS_TOO_LARGE_MESSAGE);

  app.put(`${base}/size-prices`, requireDropshipAuth, bulkLimiter, parseBody, (req, res) => respond(req, res, saveSizePricesResponseSchema,
    () => services.sizePrices.saveForMember(memberId(req), parseId(req.params.storeConnectionId), req.body)));
}

function memberRateLimit(max: number) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: LISTING_SETTING_WRITE_ERROR_CODES.rateLimited, message: "Too many saves in a minute. Wait a moment and try again." } },
  });
}

function memberId(req: Request): string {
  return req.session.dropship!.memberId;
}

/** Shorthand numbers, exponents and partly numeric ids are refused by the service's schema, not parsed. */
function parseId(value: string | undefined): number {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

async function respond<T>(req: Request, res: Response, schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<Response> {
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
    const categoryId = parseId(req.params.categoryId);
    const entry = {
      outcome: answer.errorClass === "transient" ? "deferred" : answer.errorClass === "fatal" ? "failed" : "refused",
      error_code: answer.code,
      error_class: answer.errorClass,
      status: answer.status,
      method: req.method,
      path: req.route?.path ?? req.path,
      // Correlation: one query on a store, product or member returns every refused or failed write.
      store_connection_id: Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null,
      ...(Number.isSafeInteger(productId) ? { product_id: productId } : {}),
      ...(Number.isSafeInteger(categoryId) ? { category_id: categoryId } : {}),
      ...(typeof req.params.reviewId === "string" ? { review_id: req.params.reviewId } : {}),
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
