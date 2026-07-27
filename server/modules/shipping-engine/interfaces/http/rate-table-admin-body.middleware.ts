import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { logger } from "../../../../platform/observability/logger";

const RATE_TABLE_ADMIN_BULK_POST_PATHS = new Set([
  "/api/shipping/admin/rate-tables/parse-csv",
  "/api/shipping/admin/rate-tables/drafts",
  "/api/shipping/admin/rate-tables/import",
]);
const RATE_TABLE_ADMIN_DRAFT_REPLACE_PATH =
  /^\/api\/shipping\/admin\/rate-tables\/[^/]+$/;

/**
 * The CSV contract accepts up to 2,000,000 characters and the JSON contract
 * accepts up to 5,000 expanded rows. Keep this endpoint-specific ceiling
 * bounded while leaving enough room for either supported representation.
 */
export const GLOBAL_JSON_LIMIT_BYTES = 100 * 1024;
export const RATE_TABLE_ADMIN_JSON_LIMIT_BYTES = 3 * 1024 * 1024;

const defaultJsonParser = express.json({
  limit: GLOBAL_JSON_LIMIT_BYTES,
  verify: captureRawBody,
});
const rateTableAdminBulkJsonParser = express.json({
  limit: RATE_TABLE_ADMIN_JSON_LIMIT_BYTES,
  verify: captureRawBody,
});

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  length?: number;
  limit?: number;
}

export function installGlobalJsonBodyParser(app: Express): void {
  app.use((req, res, next) => {
    if (isRateTableAdminBulkJsonRequest(req.method, req.path)) {
      next();
      return;
    }
    defaultJsonParser(req, res, next);
  });
}

/**
 * Parse large rate-table payloads only after the route's permission middleware
 * has authorized the operator.
 */
export const parseRateTableAdminBulkJson: RequestHandler = (req, res, next) => {
  rateTableAdminBulkJsonParser(req, res, (error?: unknown) => {
    if (error === undefined) {
      next();
      return;
    }
    if (isPayloadTooLarge(error)) {
      sendPayloadTooLarge(req, res, error);
      return;
    }
    if (isMalformedJson(error)) {
      res.status(400).json({
        error: {
          code: "SHIPPING_ADMIN_JSON_INVALID",
          message: "The shipping rate request body is not valid JSON.",
          details: [],
        },
      });
      return;
    }
    next(error);
  });
};

export function isRateTableAdminBulkJsonRequest(
  method: string,
  requestPath: string,
): boolean {
  const path = normalizePath(requestPath);
  if (method.toUpperCase() === "POST") {
    return RATE_TABLE_ADMIN_BULK_POST_PATHS.has(path);
  }
  return method.toUpperCase() === "PUT"
    && RATE_TABLE_ADMIN_DRAFT_REPLACE_PATH.test(path);
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function captureRawBody(req: Request, _res: Response, body: Buffer): void {
  req.rawBody = body;
}

function isPayloadTooLarge(error: unknown): error is BodyParserError {
  if (!(error instanceof Error)) return false;
  const typed = error as BodyParserError;
  return typed.type === "entity.too.large"
    || typed.status === 413
    || typed.statusCode === 413;
}

function isMalformedJson(error: unknown): error is BodyParserError {
  return error instanceof Error
    && (error as BodyParserError).type === "entity.parse.failed";
}

function sendPayloadTooLarge(
  req: Request,
  res: Response,
  error: BodyParserError,
): void {
  logger.warn("shipping.rate_table_admin_body_rejected", {
    outcome: "rejected",
    error_code: "SHIPPING_ADMIN_REQUEST_TOO_LARGE",
    method: req.method,
    path: req.path,
    content_length: req.get("content-length") ?? null,
    observed_length: error.length ?? null,
    limit_bytes: error.limit ?? RATE_TABLE_ADMIN_JSON_LIMIT_BYTES,
  });
  res.status(413).json({
    error: {
      code: "SHIPPING_ADMIN_REQUEST_TOO_LARGE",
      message:
        "The shipping rate draft is too large to save. Reduce the draft size or import it in smaller sections.",
      details: [],
    },
  });
}
