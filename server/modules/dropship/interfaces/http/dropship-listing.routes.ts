import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError, type z } from "zod";
import {
  LISTING_PUSH_RUN_ERROR_CODES,
  createListingPushRunResponseSchema,
  listListingPushRunsResponseSchema,
  listingPushRunDetailResponseSchema,
  stopListingPushRunResponseSchema,
} from "../../../../../shared/dropship/listing-push-runs";
import type { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import type { DropshipListingPushRunService } from "../../application/dropship-listing-push-run-service";
import { toDropshipVendorListingPreview } from "../../application/dropship-listing-dtos";
import { DropshipError } from "../../domain/errors";
import { LISTING_PUSH_RUN_CODES } from "../../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS } from "../../domain/listing-push-run-words";
import { logger } from "../../../../platform/observability/logger";
import { createDropshipListingPreviewServiceFromEnv } from "../../infrastructure/dropship-listing-preview.factory";
import { createDropshipListingPushRunServiceFromEnv } from "../../infrastructure/dropship-listing-push-run.factory";
import {
  requireDropshipAuth,
  requireDropshipSensitiveActionProof,
} from "./dropship-auth.routes";

export function registerDropshipListingRoutes(
  app: Express,
  service: DropshipListingPreviewService = createDropshipListingPreviewServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/listings/stores/:storeConnectionId/variants/:productVariantId/assets/:assetId/file",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const image = await service.imageForMember(req.session.dropship!.memberId, {
          storeConnectionId: Number(req.params.storeConnectionId),
          productVariantId: Number(req.params.productVariantId),
          assetId: Number(req.params.assetId),
        });
        // Private data remains authorized on every request and must not enter shared caches.
        res.set("Cache-Control", "private, no-store");
        res.set("X-Content-Type-Options", "nosniff");
        res.set("Content-Security-Policy", "default-src 'none'; sandbox");
        res.type(image.mimeType);
        return res.send(image.data);
      } catch (error) {
        return sendDropshipListingError(res, error);
      }
    },
  );
  app.post("/api/dropship/listings/preview", requireDropshipAuth, async (req, res) => {
    try {
      const preview = await service.previewForMember(req.session.dropship!.memberId, {
        storeConnectionId: req.body?.storeConnectionId,
        productVariantIds: req.body?.productVariantIds,
        requestedRetailPriceCents: req.body?.requestedRetailPriceCents,
        requestedRetailPricesByVariantId: req.body?.requestedRetailPricesByVariantId,
      });
      return res.json({ preview: toDropshipVendorListingPreview(preview) });
    } catch (error) {
      return sendDropshipListingError(res, error);
    }
  });

  app.post(
    "/api/dropship/listing-push-jobs",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("bulk_listing_push"),
    async (req, res) => {
      try {
        // Every field of the push contract is forwarded; a route test pins this
        // list to the member schema. Evidence maps were once left out here, so
        // each two-step push reached the service with no evidence and was
        // refused as changed even right after a preview. The service schema is
        // strict and refuses anything unknown.
        const result = await service.createListingPushJobForMember(req.session.dropship!.memberId, {
          storeConnectionId: req.body?.storeConnectionId,
          productVariantIds: req.body?.productVariantIds,
          reviewMode: req.body?.reviewMode,
          requestedRetailPriceCents: req.body?.requestedRetailPriceCents,
          requestedRetailPricesByVariantId: req.body?.requestedRetailPricesByVariantId,
          expectedPriceRevisionIdsByVariantId: req.body?.expectedPriceRevisionIdsByVariantId,
          expectedPriceCentsByVariantId: req.body?.expectedPriceCentsByVariantId,
          expectedRuleEvidenceHashesByVariantId: req.body?.expectedRuleEvidenceHashesByVariantId,
          expectedContentEvidenceHashesByVariantId: req.body?.expectedContentEvidenceHashesByVariantId,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          job: result.job,
          items: result.items,
          preview: toDropshipVendorListingPreview(result.preview),
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipListingError(res, error);
      }
    },
  );
}

/**
 * Publish runs (step 1 plan S2-5, PR A, §4.2 and §4.6). Each route: sign-in,
 * its member budget, then (create only) the bulk push step-up proof, so no
 * anonymous or over-budget caller reaches the proof check or the service.
 * Bodies are tiny, so the global parser serves them. Routes orchestrate only:
 * the service decides and the repository writes.
 */
export const RUN_CREATE_RATE_LIMIT = 6;
export const RUN_LIST_RATE_LIMIT = 60;
/** The page polls a run every 3 s (15 s after two minutes): 20 a minute, with room for a second tab. */
export const RUN_DETAIL_RATE_LIMIT = 120;
export const RUN_STOP_RATE_LIMIT = 10;
const RUN_RATE_LIMIT_WINDOW_MS = 60_000;
/** A busy answer is retried with the same key after this many seconds. */
const RUN_BUSY_RETRY_AFTER_SECONDS = 2;
/**
 * Database failures that did nothing and pass (the repo's own transient set: dropship-listing-settings-service.ts,
 * work-configuration.routes.ts): a statement or lock timeout, a serialization failure, a deadlock. Answered 503, so
 * the page sends the same request again, and logged WARN, not ERROR (review CT9).
 */
const TRANSIENT_DATABASE_SQLSTATES: ReadonlySet<string> = new Set(["57014", "55P03", "40001", "40P01"]);

function isTransientDatabaseError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && TRANSIENT_DATABASE_SQLSTATES.has(code);
}

export function registerDropshipListingPushRunRoutes(
  app: Express,
  service: DropshipListingPushRunService = createDropshipListingPushRunServiceFromEnv(),
): void {
  const createLimiter = memberRateLimit(RUN_CREATE_RATE_LIMIT);
  const listLimiter = memberRateLimit(RUN_LIST_RATE_LIMIT);
  const detailLimiter = memberRateLimit(RUN_DETAIL_RATE_LIMIT);
  const stopLimiter = memberRateLimit(RUN_STOP_RATE_LIMIT);

  app.post(
    "/api/dropship/listing-push-runs",
    requireDropshipAuth,
    createLimiter,
    requireDropshipSensitiveActionProof("bulk_listing_push"),
    async (req, res) => {
      try {
        const body = { ...plainObject(req.body), idempotencyKey: resolveIdempotencyKey(req) };
        const result = await service.createRunForMember(req.session.dropship!.memberId, body);
        return sendRunAnswer(res, result.idempotentReplay ? 200 : 202, createListingPushRunResponseSchema, result);
      } catch (error) {
        return sendListingPushRunError(req, res, error);
      }
    },
  );
  app.get("/api/dropship/listing-push-runs", requireDropshipAuth, listLimiter, async (req, res) => {
    try {
      const result = await service.listRunsForMember(req.session.dropship!.memberId, {
        storeConnectionId: queryWholeNumber(req.query.storeConnectionId),
        ...(req.query.limit === undefined ? {} : { limit: queryWholeNumber(req.query.limit) }),
      });
      return sendRunAnswer(res, 200, listListingPushRunsResponseSchema, result);
    } catch (error) {
      return sendListingPushRunError(req, res, error);
    }
  });
  app.get("/api/dropship/listing-push-runs/:runId", requireDropshipAuth, detailLimiter, async (req, res) => {
    try {
      const result = await service.getRunForMember(req.session.dropship!.memberId, {
        runId: queryWholeNumber(req.params.runId),
        ...(req.query.problemsAfter === undefined ? {} : { problemsAfter: queryWholeNumber(req.query.problemsAfter) }),
      });
      return sendRunAnswer(res, 200, listingPushRunDetailResponseSchema, result);
    } catch (error) {
      return sendListingPushRunError(req, res, error);
    }
  });
  // No step-up: a stop only reduces what is sent (§4.6). Idempotent by state.
  app.post("/api/dropship/listing-push-runs/:runId/stop", requireDropshipAuth, stopLimiter, async (req, res) => {
    try {
      const result = await service.stopRunForMember(req.session.dropship!.memberId, queryWholeNumber(req.params.runId));
      return sendRunAnswer(res, 200, stopListingPushRunResponseSchema, result);
    } catch (error) {
      return sendListingPushRunError(req, res, error);
    }
  });
}

/** One budget per route and member: memberRateLimit builds a new counter on every call. */
function memberRateLimit(max: number) {
  return rateLimit({
    windowMs: RUN_RATE_LIMIT_WINDOW_MS,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: LISTING_PUSH_RUN_ERROR_CODES.rateLimited, message: LISTING_PUSH_RUN_WORDS.rateLimited } },
  });
}

/** Digits only become a number; anything else is NaN, which the service's schema refuses. */
function queryWholeNumber(value: unknown): number {
  return typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
}

function plainObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Every answer is parsed with its route contract before it is sent; a broken answer is a 500, never a guess. */
function sendRunAnswer<T>(res: Response, status: number, schema: z.ZodType<T>, value: unknown): Response {
  const parsed = schema.parse(value);
  res.set("Cache-Control", "private, no-store");
  return res.status(status).json(parsed);
}

export function statusForListingPushRunError(code: string): number {
  switch (code) {
    case LISTING_PUSH_RUN_ERROR_CODES.invalidInput:
    case LISTING_PUSH_RUN_ERROR_CODES.keyRequired:
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
    case "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case LISTING_PUSH_RUN_ERROR_CODES.notFound:
      return 404;
    case LISTING_PUSH_RUN_ERROR_CODES.idempotencyConflict:
    case LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict:
    case LISTING_PUSH_RUN_ERROR_CODES.runActive:
    case LISTING_PUSH_RUN_ERROR_CODES.busy:
      return 409;
    case LISTING_PUSH_RUN_ERROR_CODES.empty:
    case LISTING_PUSH_RUN_ERROR_CODES.tooLarge:
      return 422;
    default:
      return 500;
  }
}

/** The context fields a page acts on, per code; nothing else of an error's context leaves the server. */
const RUN_ERROR_CONTEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [LISTING_PUSH_RUN_ERROR_CODES.runActive]: ["runId"],
  [LISTING_PUSH_RUN_ERROR_CODES.empty]: ["scope", "liveCount", "selectedCount"],
  [LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict]: ["expectedSelectionRevisionId", "currentSelectionRevisionId"],
  [LISTING_PUSH_RUN_ERROR_CODES.tooLarge]: ["limit"],
  DROPSHIP_LISTING_VENDOR_BLOCKED: ["resolution"],
  DROPSHIP_LISTING_ENTITLEMENT_BLOCKED: ["resolution"],
  DROPSHIP_LISTING_STORE_BLOCKED: ["resolution"],
};

function sendListingPushRunError(req: Request, res: Response, error: unknown): Response {
  const known = error instanceof DropshipError ? error : null;
  const passing = !known && isTransientDatabaseError(error);
  const status = known ? statusForListingPushRunError(known.code) : passing ? 503 : 500;
  const code = known && status !== 500 ? known.code
    : passing ? LISTING_PUSH_RUN_ERROR_CODES.unavailable : "DROPSHIP_LISTING_PUSH_RUN_INTERNAL_ERROR";
  // Transient: retried with the same key. Fatal: needs a human. The rest are refusals the page explains (DEBUG).
  const errorClass = status === 500 ? "fatal"
    : code === LISTING_PUSH_RUN_ERROR_CODES.busy || passing ? "transient" : "permanent";
  const entry = {
    outcome: errorClass === "transient" ? "deferred" : errorClass === "fatal" ? "failed" : "refused",
    error_code: code, error_class: errorClass, status, method: req.method, path: req.route?.path ?? req.path,
    // Correlation: one query on a member, store or run returns every refused or failed run request.
    actor_id: req.session?.dropship?.memberId ?? null,
    run_id: /^\d+$/.test(String(req.params?.runId ?? "")) ? Number(req.params.runId) : null,
    store_connection_id: typeof req.body?.storeConnectionId === "number" ? req.body.storeConnectionId : null,
  };
  if (errorClass === "fatal") {
    logger.error("dropship.listing_push_runs.request_failed", {
      ...entry, error_message: error instanceof Error ? error.message : String(error),
      ...(known ? { internal_code: known.code } : {}),
    });
    return res.status(500).json({ error: { code, message: LISTING_PUSH_RUN_WORDS.requestFailed } });
  }
  if (errorClass === "transient") {
    logger.warn("dropship.listing_push_runs.request_deferred", passing
      ? { ...entry, sql_state: (error as { code: string }).code, error_message: error instanceof Error ? error.message : String(error) }
      : entry);
    res.set("Retry-After", String(RUN_BUSY_RETRY_AFTER_SECONDS));
    if (passing) return res.status(status).json({ error: { code, message: LISTING_PUSH_RUN_WORDS.unavailable } });
  } else {
    logger.debug("dropship.listing_push_runs.request_refused", entry);
  }
  const fields = RUN_ERROR_CONTEXT_FIELDS[code] ?? [];
  const context = Object.fromEntries(fields.filter((field) => known?.context?.[field] !== undefined)
    .map((field) => [field, known!.context![field]]));
  return res.status(status).json({
    error: { code, message: known!.message, ...(Object.keys(context).length > 0 ? { context } : {}) },
  });
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function sendDropshipListingError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipListingError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_LISTING_INVALID_INPUT",
        message: "Dropship listing request failed validation.",
        context: { issues: error.issues },
      },
    });
  }

  console.error("[DropshipListingRoutes] Unexpected listing request error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_LISTING_INTERNAL_ERROR",
      message: "Dropship listing request failed.",
    },
  });
}

function statusForDropshipListingError(code: string): number {
  switch (code) {
    case "DROPSHIP_LISTING_INVALID_INPUT":
    case "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID":
    case "DROPSHIP_LISTING_PUSH_REVIEW_MODE_CONFLICT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
    // A vendor key in the prefix only publish runs' chunk jobs use (SAFETY14).
    case LISTING_PUSH_RUN_CODES.keyReserved:
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
    case "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
    case "DROPSHIP_LISTING_IMAGE_NOT_FOUND":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT":
    case "DROPSHIP_CONTENT_VERSION_CONFLICT":
      return 409;
    default:
      return 500;
  }
}
