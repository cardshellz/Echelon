import express, { type RequestHandler } from "express";
import { logger } from "../../../../platform/observability/logger";

/**
 * A full eBay category rule set may name up to 10,000 listings (about 70 KB of
 * ids alone), which the 100 KB global JSON limit cannot hold with its rules.
 * The larger ceiling applies only to these authenticated routes.
 */
export const DROPSHIP_BULK_JSON_LIMIT_BYTES = 1024 * 1024;
const EBAY_CATEGORY_RULES_PATH = /^\/api\/dropship\/listings\/stores\/[^/]+\/ebay-category-rules$/;
const EBAY_CATEGORY_RULES_REVIEW_PATH = /^\/api\/dropship\/listings\/stores\/[^/]+\/ebay-category-rules\/review$/;
const parser = express.json({ limit: DROPSHIP_BULK_JSON_LIMIT_BYTES });

/** The global parser skips these requests; the route parses them after authentication. */
export function isDropshipBulkJsonRequest(method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const verb = method.toUpperCase();
  return (verb === "PUT" && EBAY_CATEGORY_RULES_PATH.test(normalized))
    || (verb === "POST" && EBAY_CATEGORY_RULES_REVIEW_PATH.test(normalized));
}

/** Register only after `requireDropshipAuth`, so anonymous callers cannot make the server parse a large body. */
export const parseDropshipBulkJson: RequestHandler = (req, res, next) => {
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
      return res.status(413).json({ error: {
        code: "DROPSHIP_REQUEST_TOO_LARGE",
        message: "These rules are too large to save at once. Use category, product or product-line rules instead of long lists of single listings.",
      } });
    }
    if (type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "DROPSHIP_REQUEST_JSON_INVALID", message: "The request body is not valid JSON." } });
    }
    return next(error);
  });
};
