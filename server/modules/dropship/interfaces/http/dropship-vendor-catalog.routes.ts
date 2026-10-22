import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { z } from "zod";
import { db, pool } from "../../../../db";
import { createAllocationEngine } from "../../../channels/allocation-engine.service";
import { createAuthorityAwareInventoryAtpService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { createInventoryChannelQuantityRuntimeService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-publication.repository";
import {
  DropshipSelectionAtpService,
  systemDropshipSelectionAtpClock,
} from "../../application/dropship-selection-atp-service";
import { ChannelAllocationDropshipAtpProvider } from "../../infrastructure/dropship-atp.provider";
import { createDropshipListingTierServiceFromEnv } from "../../infrastructure/dropship-listing-tier.factory";
import { resolveDropshipOmsChannelIdWithClient } from "../../infrastructure/dropship-order-intake.repository";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { platformDropshipLogger } from "../../infrastructure/dropship-listing-push-run.factory";
import { DropshipError } from "../../domain/errors";
import { publicationSelectionBusyIssue } from "../../../inventory-planning/publication-selection-work";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { logger } from "../../../../platform/observability/logger";
import { CATALOG_READ_WORDS } from "../../domain/catalog-read-words";
import { DROPSHIP_CATALOG_CODE_VERSION, decideCatalogPageVersion } from "../../domain/catalog-code-version";
import {
  DROPSHIP_CATALOG_IDS_PURPOSES,
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_CATALOG_SELECTION_FILTERS,
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogReadSummarySchema,
  dropshipCatalogSelectionSummarySchema,
} from "../../../../../shared/dropship/vendor-catalog-reads";

/**
 * Member budgets for the catalog reads step 1 plan S2-5 adds (§4.8): an id
 * list and the categories are whole-catalog scans; the selection summary is
 * read on each step 3 load and after each save.
 */
export const CATALOG_IDS_RATE_LIMIT = 30;
export const CATALOG_CATEGORIES_RATE_LIMIT = 30;
export const CATALOG_SELECTION_SUMMARY_RATE_LIMIT = 60;
const CATALOG_RATE_LIMIT_WINDOW_MS = 60_000;
/** A page newer than this server retries after this many seconds (an older dyno is being replaced). */
export const CATALOG_PAGE_NEWER_RETRY_AFTER_SECONDS = 5;

export function registerDropshipVendorCatalogRoutes(
  app: Express,
  service: DropshipSelectionAtpService = createDropshipSelectionAtpServiceFromEnv(),
): void {
  app.get("/api/dropship/catalog/selection-rules", requireDropshipAuth, async (req, res) => {
    try {
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.listSelectionRules({
        vendorId: vendor.vendorId,
        includeInactive: parseBooleanQuery(req.query.includeInactive, false),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  app.put(
    "/api/dropship/catalog/selection-rules",
    requireDropshipAuth,
    async (req, res) => {
      try {
        const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
        const result = await service.replaceSelectionRules({
          vendorId: vendor.vendorId,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: {
            actorType: "vendor",
            actorId: req.session.dropship!.memberId,
          },
          rules: req.body?.rules,
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipVendorCatalogError(req, res, error);
      }
    },
  );

  const idsLimiter = memberRateLimit(CATALOG_IDS_RATE_LIMIT);
  const categoriesLimiter = memberRateLimit(CATALOG_CATEGORIES_RATE_LIMIT);
  const selectionSummaryLimiter = memberRateLimit(CATALOG_SELECTION_SUMMARY_RATE_LIMIT);
  // Only an id list spends the id budget; a table page reads as it always did.
  const idsOnlyLimiter = (req: Request, res: Response, next: NextFunction) => (
    parseOptionalStringQuery(req.query.idsOnly) === "true" ? idsLimiter(req, res, next) : next()
  );

  app.get("/api/dropship/catalog", requireDropshipAuth, idsOnlyLimiter, async (req, res) => {
    try {
      // The page version first (CHK7): a newer page must not read rows with this release's meaning.
      assertPageNotNewerThanServer(req);
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const filter = {
        vendorId: vendor.vendorId,
        search: parseOptionalStringQuery(req.query.search),
        category: parseOptionalStringQuery(req.query.category),
        categoryId: parseOptionalIdQuery(req.query.categoryId, "categoryId"),
        productLineId: parseOptionalNumberQuery(req.query.productLineId),
        productLineIds: parseOptionalNumberListQuery(req.query.productLineIds),
        productId: parseOptionalNumberQuery(req.query.productId),
        selection: parseEnumQuery(req.query.selection, DROPSHIP_CATALOG_SELECTION_FILTERS, "selection"),
        // The stage 1 alias: it keeps its old lenient reading (anything but "true"/"false" is false).
        selectedOnly: parseBooleanQuery(req.query.selectedOnly, false),
      };
      if (parseStrictBooleanQuery(req.query.idsOnly, "idsOnly", false)) {
        const purpose = parseEnumQuery(req.query.purpose, DROPSHIP_CATALOG_IDS_PURPOSES, "purpose");
        if (!purpose) throw catalogQueryInvalid("purpose");
        const ids = await service.listCatalogIds({ ...filter, purpose });
        return sendCatalogAnswer(res, parseOutbound(dropshipCatalogIdsAnswerSchema, ids));
      }
      if (req.query.purpose !== undefined) {
        // A purpose without idsOnly is a page that means an id list; never answer it with a table page.
        parseEnumQuery(req.query.purpose, DROPSHIP_CATALOG_IDS_PURPOSES, "purpose");
        throw catalogQueryInvalid("idsOnly");
      }
      const result = await service.previewCatalog({
        ...filter,
        includeFacets: parseStrictBooleanQuery(req.query.includeFacets, "includeFacets", true),
        page: parseNumberQuery(req.query.page, 1),
        limit: parseNumberQuery(req.query.limit, 50),
      });
      // The rows keep their existing shape; the new summary is parsed with its contract.
      return sendCatalogAnswer(res, { ...result, summary: parseOutbound(dropshipCatalogReadSummarySchema, result.summary) });
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  app.get("/api/dropship/catalog/categories", requireDropshipAuth, categoriesLimiter, async (req, res) => {
    try {
      assertPageNotNewerThanServer(req);
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.listCatalogCategories({ vendorId: vendor.vendorId });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogCategoriesAnswerSchema, result));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  app.get("/api/dropship/catalog/selection", requireDropshipAuth, selectionSummaryLimiter, async (req, res) => {
    try {
      assertPageNotNewerThanServer(req);
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.readSelectionSummary({
        vendorId: vendor.vendorId,
        storeConnectionId: parseOptionalIdQuery(req.query.storeConnectionId, "storeConnectionId") ?? null,
      });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogSelectionSummarySchema, result));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });
}

/** One budget per route and member: each call builds a new counter. */
function memberRateLimit(max: number) {
  return rateLimit({
    windowMs: CATALOG_RATE_LIMIT_WINDOW_MS,
    max,
    keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: DROPSHIP_CATALOG_READ_ERROR_CODES.rateLimited, message: CATALOG_READ_WORDS.rateLimited } },
  });
}

/** A catalog read's answer, already checked with its contract (parseOutbound). */
function sendCatalogAnswer(res: Response, checked: unknown): Response {
  res.set("Cache-Control", "private, no-store");
  return res.json(checked);
}

/**
 * Every new answer is parsed with its contract before it is sent. A broken
 * answer is the server's own fault: a plain Error, so it answers 500 and is
 * logged at ERROR, never a guessed shape and never a 400 that blames the page.
 */
function parseOutbound<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Dropship vendor catalog answer failed its contract: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
}

/**
 * `clientVersion` (optional, a whole number ≥ 1): the catalog code version the
 * page was built for. A newer page than this server answers 503 "try again"
 * (transient), so B's and C's pages that reach an A dyno during a release
 * retry instead of reading rows with A's meaning (§4.8, CHK7).
 */
function assertPageNotNewerThanServer(req: Request): void {
  const clientVersion = parseOptionalIdQuery(req.query.clientVersion, "clientVersion") ?? null;
  if (decideCatalogPageVersion(clientVersion) === "page_newer_than_server") {
    throw new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, CATALOG_READ_WORDS.pageNewerThanServer, {
      reason: DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
      clientVersion,
      serverVersion: DROPSHIP_CATALOG_CODE_VERSION,
      retryable: true,
    });
  }
}

function catalogQueryInvalid(parameter: string): DropshipError {
  return new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.queryInvalid, CATALOG_READ_WORDS.queryInvalid, {
    parameter,
    retryable: false,
  });
}

/** An enum query value: absent is undefined; a known value is itself; anything else is refused, never a fallback. */
function parseEnumQuery<const T extends readonly string[]>(value: unknown, allowed: T, parameter: string): T[number] | undefined {
  if (value === undefined) return undefined;
  const parsed = parseOptionalStringQuery(value);
  if (parsed !== undefined && (allowed as readonly string[]).includes(parsed)) return parsed as T[number];
  throw catalogQueryInvalid(parameter);
}

/** A flag the new page sends: "true" or "false", or absent for the fallback; anything else is refused. */
function parseStrictBooleanQuery(value: unknown, parameter: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const parsed = parseOptionalStringQuery(value);
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw catalogQueryInvalid(parameter);
}

/** An id query value the new page sends: absent is undefined; digits only, positive; anything else is refused. */
function parseOptionalIdQuery(value: unknown, parameter: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseOptionalStringQuery(value);
  const asNumber = parsed !== undefined && /^\d{1,10}$/.test(parsed) ? Number(parsed) : Number.NaN;
  if (Number.isSafeInteger(asNumber) && asNumber > 0 && asNumber <= 2_147_483_647) return asNumber;
  throw catalogQueryInvalid(parameter);
}

function createDropshipSelectionAtpServiceFromEnv(): DropshipSelectionAtpService {
  return new DropshipSelectionAtpService({
    clock: systemDropshipSelectionAtpClock,
    // The platform JSON logger (CLAUDE.md §10), not console: the selection save's replaced/replayed events.
    logger: platformDropshipLogger("dropship.vendor_selection"),
    repository: new PgDropshipSelectionAtpRepository(),
    // Dropship quantity is the Dropship OMS channel's Channel Allocation result
    // (handoff Option B), computed over the authority-aware ATP reader.
    atp: new ChannelAllocationDropshipAtpProvider({
      allocationEngine: createAllocationEngine(db, createAuthorityAwareInventoryAtpService(pool)),
      runtimeQuantity: createInventoryChannelQuantityRuntimeService(pool),
      resolveDropshipOmsChannelId: () => resolveDropshipOmsChannelIdWithClient(pool),
    }),
    listingTiers: createDropshipListingTierServiceFromEnv(),
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

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalNumberQuery(value: unknown): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  const asNumber = Number(parsed);
  return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : undefined;
}

function parseOptionalNumberListQuery(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const parsed = value.flatMap((item) => parseOptionalNumberListQuery(item) ?? []);
    return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
  }
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  const numbers = parsed
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return numbers.length > 0 ? Array.from(new Set(numbers)) : undefined;
}

function parseNumberQuery(value: unknown, fallback: number): number {
  return parseOptionalNumberQuery(value) ?? fallback;
}

function parseBooleanQuery(value: unknown, fallback: boolean): boolean {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return fallback;
  }
  if (parsed === "true") {
    return true;
  }
  if (parsed === "false") {
    return false;
  }
  return fallback;
}

function sendDropshipVendorCatalogError(req: Request, res: Response, error: unknown) {
  const busy = publicationSelectionBusyIssue(error);
  if (busy) return res.status(409).json({ error: busy });
  if (error instanceof DropshipError) {
    const status = statusForDropshipVendorCatalogError(error.code);
    logCatalogRefusal(req, error, status);
    if (status === 503 && error.code === DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused) {
      res.set("Retry-After", String(CATALOG_PAGE_NEWER_RETRY_AFTER_SECONDS));
    }
    return res.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  if (error && typeof error === "object" && "issues" in error) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_VENDOR_CATALOG_INVALID_INPUT",
        message: "Dropship vendor catalog input failed validation.",
        context: { issues: (error as { issues: unknown }).issues },
      },
    });
  }

  // ERROR: needs a human (CLAUDE.md §10); the answer names no internals.
  logger.error("dropship.vendor_catalog.request_failed", {
    outcome: "failed",
    error_code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR",
    error_class: "fatal",
    method: req.method,
    path: req.route?.path ?? req.path,
    actor_id: req.session?.dropship?.memberId ?? null,
    error_message: error instanceof Error ? error.message : String(error),
  });
  return res.status(500).json({
    error: {
      code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR",
      message: "Dropship vendor catalog request failed.",
    },
  });
}

/**
 * A refusal the page explains is expected (DEBUG); the retired-rules answer is
 * the one state transition the plan asks to see (INFO, §4.9 item 2); an
 * unavailable read the page retries is WARN.
 */
function logCatalogRefusal(req: Request, error: DropshipError, status: number): void {
  const entry = {
    outcome: status >= 500 ? "deferred" : "refused",
    error_code: error.code,
    error_class: status >= 500 ? "transient" : "permanent",
    status,
    method: req.method,
    path: req.route?.path ?? req.path,
    actor_id: req.session?.dropship?.memberId ?? null,
  };
  if (error.code === DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired) {
    logger.info("dropship.selection.rules_retired_refused", entry);
  } else if (status >= 500 && error.code !== DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused) {
    logger.warn("dropship.vendor_catalog.request_deferred", entry);
  } else {
    // A newer page during a release is expected and retried by the page (DEBUG, not a repeated WARN).
    logger.debug("dropship.vendor_catalog.request_refused", entry);
  }
}

export function statusForDropshipVendorCatalogError(code: string): number {
  if (code === "DROPSHIP_IDEMPOTENCY_CONFLICT") {
    return 409;
  }
  // Step 1 plan S2-5 §4.12.
  if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.queryInvalid || code === "DROPSHIP_IDEMPOTENCY_KEY_RESERVED") {
    return 400;
  }
  if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.storeRequired) {
    return 404;
  }
  // B froze the rules table: the page is older than the server's selection model (D39).
  if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired) {
    return 410;
  }
  if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany) {
    return 422;
  }
  if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused) {
    return 503;
  }
  if (code === "DROPSHIP_VENDOR_PROFILE_REQUIRED") {
    return 409;
  }
  if (code === "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED") {
    return 403;
  }
  if (code === "DROPSHIP_AUTH_REQUIRED") {
    return 401;
  }
  if (code === "DROPSHIP_STEP_UP_REQUIRED" || code === "DROPSHIP_STEP_UP_METHOD_REQUIRED") {
    return 403;
  }
  // Program configuration is incomplete (no enabled warehouse for Dropship OMS, or
  // the channel itself is missing); the vendor cannot fix it, so it is a conflict.
  if (
    code === "DROPSHIP_ALLOCATION_WAREHOUSE_SCOPE_REQUIRED"
    || code === "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED"
    || code === "DROPSHIP_OMS_CHANNEL_CONFIG_AMBIGUOUS"
  ) {
    return 409;
  }
  // Allocation could not be computed on this request; the read is retryable.
  if (code === "DROPSHIP_ALLOCATION_UNAVAILABLE") {
    return 503;
  }
  return 400;
}
