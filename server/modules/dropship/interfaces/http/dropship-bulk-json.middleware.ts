import express, { type RequestHandler } from "express";
import { logger } from "../../../../platform/observability/logger";

/**
 * A full eBay category rule set may name up to 10,000 listings (about 70 KB of
 * ids alone), which the 100 KB global JSON limit cannot hold with its rules;
 * so may a listing-settings bulk write (Listing settings design 8.8). The
 * larger ceiling applies only to the authenticated routes in BULK_JSON_PATHS.
 */
export const DROPSHIP_BULK_JSON_LIMIT_BYTES = 1024 * 1024;

/** What a too-large body is told, by the route it was sent to; each is pinned by its route test. */
export const EBAY_CATEGORY_RULES_TOO_LARGE_MESSAGE =
  "These rules are too large to save at once. Use category, product or product-line rules instead of long lists of single listings.";
export const LISTING_SETTINGS_TOO_LARGE_MESSAGE = "This change is too large to send at once. Choose fewer products.";
export const PRICING_RULES_TOO_LARGE_MESSAGE =
  "These pricing rules are too large to save at once. Use category, product or product-line rules instead of long lists of single sizes.";
/** A content profile is large from its template text alone (up to 100 groups of two 4,000-character parts). */
export const CONTENT_PROFILE_TOO_LARGE_MESSAGE = "These descriptions are too large to save at once. Use fewer description groups or shorter text.";

const STORE_PATH = String.raw`^\/api\/dropship\/listings\/stores\/[^/]+`;
const storePath = (suffix: string) => new RegExp(`${STORE_PATH}${suffix}$`);

/**
 * Every route the global parser skips; each parses its own body after
 * authentication and its rate limit, with parseDropshipBulkJsonFor. A route
 * added here without that parser would get no body at all.
 */
export const BULK_JSON_PATHS: ReadonlyArray<{ method: "POST" | "PUT"; pattern: RegExp }> = Object.freeze([
  { method: "PUT", pattern: storePath(String.raw`\/ebay-category-rules`) },
  { method: "POST", pattern: storePath(String.raw`\/ebay-category-rules\/review`) },
  { method: "POST", pattern: storePath(String.raw`\/pricing-rules\/reviews`) },
  { method: "PUT", pattern: storePath(String.raw`\/content-profile`) },
  { method: "PUT", pattern: storePath(String.raw`\/listing-settings\/size-prices`) },
  { method: "PUT", pattern: storePath(String.raw`\/listing-settings\/products\/[^/]+`) },
  { method: "POST", pattern: storePath(String.raw`\/listing-settings\/products\/bulk`) },
]);

/** The global parser skips these requests; the route parses them after authentication. */
export function isDropshipBulkJsonRequest(method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const verb = method.toUpperCase();
  return BULK_JSON_PATHS.some((entry) => entry.method === verb && entry.pattern.test(normalized));
}

/**
 * The 1 MiB parser for one route, answering a too-large body with that
 * route's words. Register only after `requireDropshipAuth` and the route's
 * limiter, so anonymous callers cannot make the server parse a large body.
 */
export function parseDropshipBulkJsonFor(tooLargeMessage: string): RequestHandler {
  const parser = express.json({ limit: DROPSHIP_BULK_JSON_LIMIT_BYTES });
  return (req, res, next) => {
    parser(req, res, (error?: unknown) => {
      if (error === undefined) return next();
      const type = error instanceof Error && "type" in error ? (error as { type?: unknown }).type : undefined;
      if (type === "entity.too.large") {
        logger.warn("dropship.bulk_json_body_rejected", {
          outcome: "rejected",
          error_code: "DROPSHIP_REQUEST_TOO_LARGE",
          method: req.method,
          path: req.path,
          content_length: req.get("content-length") ?? null,
          limit_bytes: DROPSHIP_BULK_JSON_LIMIT_BYTES,
        });
        return res.status(413).json({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: tooLargeMessage } });
      }
      if (type === "entity.parse.failed") {
        return res.status(400).json({ error: { code: "DROPSHIP_REQUEST_JSON_INVALID", message: "The request body is not valid JSON." } });
      }
      return next(error);
    });
  };
}

/** The eBay category rules routes' parser, with their own words. */
export const parseDropshipBulkJson: RequestHandler = parseDropshipBulkJsonFor(EBAY_CATEGORY_RULES_TOO_LARGE_MESSAGE);
