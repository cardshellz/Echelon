import { randomInt } from "node:crypto";
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
import {
  DropshipSelectionChangeService,
  SELECTION_CHANGE_PLAN_MOVED,
  seededJitterSource,
  selectionPicksWritesDisabled,
} from "../../application/dropship-selection-change-service";
import { readSelectionChangeClientVersion } from "../../application/dropship-selection-change-dtos";
import {
  parseCatalogNoticeAcknowledgeBody,
  readCatalogNoticeAcknowledgeClientVersion,
} from "../../application/dropship-selection-dtos";
import type { DropshipCatalogArrivalsService } from "../../application/dropship-catalog-arrivals-service";
import { createDropshipCatalogArrivalsServiceFromEnv } from "../../infrastructure/dropship-catalog-arrivals.factory";
import { CATALOG_ARRIVALS_ERROR_CODES } from "../../domain/catalog-arrivals";
import type { DropshipLogEvent, DropshipLogger } from "../../application/dropship-ports";
import { ChannelAllocationDropshipAtpProvider } from "../../infrastructure/dropship-atp.provider";
import { createDropshipListingTierServiceFromEnv } from "../../infrastructure/dropship-listing-tier.factory";
import { resolveDropshipOmsChannelIdWithClient } from "../../infrastructure/dropship-order-intake.repository";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { PgDropshipSelectionChangeRepository } from "../../infrastructure/dropship-selection-change.repository";
import { platformDropshipLogger } from "../../infrastructure/dropship-listing-push-run.factory";
import { DropshipError } from "../../domain/errors";
import { publicationSelectionBusyIssue } from "../../../inventory-planning/publication-selection-work";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { SELECTION_CHANGE_TOO_LARGE_MESSAGE, parseDropshipBulkJsonFor } from "./dropship-bulk-json.middleware";
import { logger } from "../../../../platform/observability/logger";
import { CATALOG_READ_WORDS } from "../../domain/catalog-read-words";
import { DROPSHIP_CATALOG_CODE_VERSION, decideCatalogPageVersion, isCatalogPageOutdated } from "../../domain/catalog-code-version";
import {
  DROPSHIP_CATALOG_IDS_PURPOSES,
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_CATALOG_SELECTION_FILTERS,
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogNewItemsAnswerSchema,
  dropshipCatalogNoticeAcknowledgeAnswerSchema,
  dropshipCatalogReadSummarySchema,
  dropshipCatalogSelectionSummarySchema,
} from "../../../../../shared/dropship/vendor-catalog-reads";
import {
  SELECTION_CHANGE_ERROR_CODES,
  selectionChangeAnswerSchema,
  selectionChangePreviewAnswerSchema,
} from "../../../../../shared/dropship/vendor-selection-changes";

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
/** Member budgets of step 1's picks save (PLAN-B v4.1 §8.2, §8.3): a preview per confirm, a save per press and its retries. */
export const SELECTION_CHANGE_PREVIEW_RATE_LIMIT = 30;
export const SELECTION_CHANGE_RATE_LIMIT = 20;
/** Member budgets of step 1's new-items notice (PLAN-B v4.1 §11.4): read on each step 1 load and after a save; "Got it" per press. */
export const CATALOG_NEW_ITEMS_RATE_LIMIT = 60;
export const CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT = 30;

/** The arrivals job's two step 1 calls the routes make (dropship-catalog-arrivals-service.ts). */
export type DropshipCatalogNewItemsRouteService = Pick<DropshipCatalogArrivalsService, "readNewItems" | "acknowledge">;

export function registerDropshipVendorCatalogRoutes(
  app: Express,
  service: DropshipSelectionAtpService = createDropshipSelectionAtpServiceFromEnv(),
  changeService: DropshipSelectionChangeService = createDropshipSelectionChangeServiceFromEnv(),
  newItemsService: DropshipCatalogNewItemsRouteService = createDropshipCatalogArrivalsServiceFromEnv(),
): void {
  app.get("/api/dropship/catalog/selection-rules", requireDropshipAuth, async (req, res) => {
    try {
      const vendor = await requireSessionVendor(service, req, res);
      const result = await service.listSelectionRules({
        vendorId: vendor.vendorId,
        includeInactive: parseBooleanQuery(req.query.includeInactive, false),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  // PR B froze the rules (PLAN-B v4.1 §8.4, V10): an older page's save is told to reload, before any database call.
  app.put("/api/dropship/catalog/selection-rules", requireDropshipAuth, (req, res) => sendDropshipVendorCatalogError(req, res,
    new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired, CATALOG_READ_WORDS.retired, {
      retryable: false,
      classification: "permanent",
    })));

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
      const vendor = await requireSessionVendor(service, req, res);
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
      const vendor = await requireSessionVendor(service, req, res);
      const result = await service.listCatalogCategories({ vendorId: vendor.vendorId });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogCategoriesAnswerSchema, result));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  app.get("/api/dropship/catalog/selection", requireDropshipAuth, selectionSummaryLimiter, async (req, res) => {
    try {
      assertPageNotNewerThanServer(req);
      const vendor = await requireSessionVendor(service, req, res);
      const result = await service.readSelectionSummary({
        vendorId: vendor.vendorId,
        storeConnectionId: parseOptionalIdQuery(req.query.storeConnectionId, "storeConnectionId") ?? null,
      });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogSelectionSummarySchema, result));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  // Step 1's picks save (PLAN-B v4.1 §8): the bulk parser after authentication and the member budget (BULK_JSON_PATHS).
  const changePreviewLimiter = memberRateLimit(SELECTION_CHANGE_PREVIEW_RATE_LIMIT);
  const changeLimiter = memberRateLimit(SELECTION_CHANGE_RATE_LIMIT);
  const parseChangeBody = parseDropshipBulkJsonFor(SELECTION_CHANGE_TOO_LARGE_MESSAGE);

  app.post("/api/dropship/catalog/selection/changes/preview", requireDropshipAuth, changePreviewLimiter, parseChangeBody,
    async (req, res) => {
      try {
        // The page version first (§8.1): a newer page's body is never read with this release's strict schema.
        assertBodyPageNotNewerThanServer(req.body);
        // PR C (PLAN-C v4.1 §4.1): an older page is told to reload before any read; a preview writes nothing, so
        // nothing is lost. The save refuses one in its service, after its replay lookup.
        assertBodyPageNotOutdated(req.body);
        const vendor = await requireSessionVendor(service, req, res);
        const answer = await changeService.preview({ vendorId: vendor.vendorId, body: req.body });
        return sendCatalogAnswer(res, parseOutbound(selectionChangePreviewAnswerSchema, answer));
      } catch (error) {
        return sendDropshipVendorCatalogError(req, res, error);
      }
    });

  app.post("/api/dropship/catalog/selection/changes", requireDropshipAuth, changeLimiter, parseChangeBody, async (req, res) => {
    try {
      assertBodyPageNotNewerThanServer(req.body);
      const memberId = req.session.dropship!.memberId;
      const vendor = await requireSessionVendor(service, req, res);
      const { answer, idempotentReplay } = await changeService.applyChange({
        vendorId: vendor.vendorId,
        actor: { actorType: "vendor", actorId: memberId },
        body: req.body,
      });
      // The first answer is 201; a replay of the same key sends the stored answer again with 200.
      res.status(idempotentReplay ? 200 : 201);
      return sendCatalogAnswer(res, parseOutbound(selectionChangeAnswerSchema, answer));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  // Step 1's new-items notice (PLAN-B v4.1 §11.4): the new sizes read live, and "Got it". Both are the session vendor's
  // only. "Got it" has a small body: the global parser, never a bulk path (BULK_JSON_PATHS).
  const newItemsLimiter = memberRateLimit(CATALOG_NEW_ITEMS_RATE_LIMIT);
  const noticeAcknowledgeLimiter = memberRateLimit(CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT);

  app.get("/api/dropship/catalog/new-items", requireDropshipAuth, newItemsLimiter, async (req, res) => {
    try {
      assertPageNotNewerThanServer(req);
      const vendor = await requireSessionVendor(service, req, res);
      const answer = await newItemsService.readNewItems({ vendorId: vendor.vendorId });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogNewItemsAnswerSchema, answer));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });

  app.post("/api/dropship/catalog/new-items/acknowledge", requireDropshipAuth, noticeAcknowledgeLimiter, async (req, res) => {
    try {
      // The page version before the strict body (SAFETY-13): a newer page is told to try again, never a permanent 400.
      assertBodyPageNotNewerThanServer(req.body, readCatalogNoticeAcknowledgeClientVersion);
      const body = parseCatalogNoticeAcknowledgeBody(req.body);
      const memberId = req.session.dropship!.memberId;
      const vendor = await requireSessionVendor(service, req, res);
      const answer = await newItemsService.acknowledge({
        vendorId: vendor.vendorId,
        actor: { actorType: "vendor", actorId: memberId },
        categoryId: body.categoryId,
        throughArrivalId: body.throughArrivalId,
      });
      return sendCatalogAnswer(res, parseOutbound(dropshipCatalogNoticeAcknowledgeAnswerSchema, answer));
    } catch (error) {
      return sendDropshipVendorCatalogError(req, res, error);
    }
  });
}

/** The `res.locals` key of the session vendor's id, read by the request's refusal and failure lines (SRV-2). */
const SESSION_VENDOR_ID_LOCAL = "dropshipVendorId";
/** Postgres `integer`: the largest vendor or revision id a log line names. */
const MAX_LOGGED_ID = 2_147_483_647;

/**
 * The session's vendor, remembered on the response so every refusal and
 * failure line of this request carries its id (PLAN-B v4.1 §14 "every line
 * carries vendor_id and the revision id"; CLAUDE.md §10). A refusal thrown
 * before this read (a newer page, no vendor profile) logs `vendor_id: null`.
 */
async function requireSessionVendor(service: Pick<DropshipSelectionAtpService, "requireVendorForMember">, req: Request,
  res: Response): Promise<Awaited<ReturnType<DropshipSelectionAtpService["requireVendorForMember"]>>> {
  const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
  res.locals[SESSION_VENDOR_ID_LOCAL] = vendor.vendorId;
  return vendor;
}

/** A whole positive id, else null: the body is untrusted, so an id field of a line never carries anything else. */
function loggedId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_LOGGED_ID ? value : null;
}

/**
 * The correlation ids of a catalog request's refusal or failure line: the
 * session vendor once the route read it (else the error's own `vendorId`);
 * the revision the page counted from (the error's, else the body's
 * `expectedRevisionId`); the head a save found instead (a revision conflict);
 * and the stored revision a request key named (a key conflict). Null when
 * not known.
 */
function catalogLineCorrelation(req: Request, res: Response, error?: DropshipError): {
  vendor_id: number | null; expected_revision_id: number | null; current_revision_id: number | null; revision_id: number | null;
} {
  const context = error?.context ?? {};
  const body: Record<string, unknown> = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  return {
    vendor_id: loggedId(res.locals[SESSION_VENDOR_ID_LOCAL]) ?? loggedId(context.vendorId),
    expected_revision_id: loggedId(context.expectedRevisionId) ?? loggedId(body.expectedRevisionId),
    current_revision_id: loggedId(context.currentRevisionId),
    revision_id: loggedId(context.revisionId),
  };
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

/**
 * The body's `clientVersion` (§8.1), read before the strict body schema; the same answer as a catalog read's. The
 * reader refuses a malformed version with its route's own invalid-input code.
 */
function assertBodyPageNotNewerThanServer(
  body: unknown,
  readClientVersion: (body: unknown) => number | null = readSelectionChangeClientVersion,
): void {
  const clientVersion = readClientVersion(body);
  if (decideCatalogPageVersion(clientVersion) === "page_newer_than_server") {
    throw new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, CATALOG_READ_WORDS.pageNewerThanServer, {
      reason: DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
      clientVersion,
      serverVersion: DROPSHIP_CATALOG_CODE_VERSION,
      retryable: true,
      classification: "transient",
    });
  }
}

/**
 * PR C's refusal of a step 1 preview from an older page (§4.1, D39): 409 `DROPSHIP_SELECTION_PAGE_OUTDATED` with the
 * page's own `retired` words, so it offers Reload. Permanent for that page.
 */
function assertBodyPageNotOutdated(body: unknown): void {
  const clientVersion = readSelectionChangeClientVersion(body);
  if (isCatalogPageOutdated(clientVersion)) {
    throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.pageOutdated, CATALOG_READ_WORDS.retired, {
      clientVersion,
      serverVersion: DROPSHIP_CATALOG_CODE_VERSION,
      retryable: false,
      classification: "permanent",
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
    // `selection=new` reads the new-items notice's own rule (PLAN-B v4.1 §11.4).
    newItems: createDropshipCatalogArrivalsServiceFromEnv(),
  });
}

function createDropshipSelectionChangeServiceFromEnv(): DropshipSelectionChangeService {
  return new DropshipSelectionChangeService({
    repository: new PgDropshipSelectionChangeRepository(pool),
    clock: systemDropshipSelectionAtpClock,
    logger: selectionChangeLogger(),
    sleep: (delayMs) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }),
    // The jitter's seed is drawn once per process here, at the composition root; the service never reads randomness.
    random: seededJitterSource(randomInt(0, 2 ** 31 - 1)),
    picksWritesDisabled: () => selectionPicksWritesDisabled(process.env),
  });
}

/**
 * The picks save's lines under their own event names (dropship.selection.*), JSON through the platform logger:
 * the event's code is the line's action, so a context can never rename it or change its level.
 */
export function selectionChangeLogger(): DropshipLogger {
  const line = (event: DropshipLogEvent) => {
    const { level: _level, action: _action, ...context } = event.context ?? {};
    return { message: event.message, ...context };
  };
  return {
    debug: (event) => logger.debug(event.code, line(event)),
    info: (event) => logger.info(event.code, line(event)),
    warn: (event) => logger.warn(event.code, line(event)),
    error: (event) => logger.error(event.code, line(event)),
  };
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
    logCatalogRefusal(req, res, error, status);
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
    ...catalogLineCorrelation(req, res),
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
 * unavailable read the page retries is WARN; a fatal error needs a human
 * (ERROR). The error's own classification (`context.classification`) names
 * its class when it has one, so the transient 409 "busy" logs as transient
 * (PLAN-B v4.1 §14); otherwise a 5xx is transient and a 4xx permanent.
 */
function logCatalogRefusal(req: Request, res: Response, error: DropshipError, status: number): void {
  const declared = error.context?.classification;
  const errorClass = declared === "transient" || declared === "permanent" || declared === "fatal"
    ? declared
    : status >= 500 ? "transient" : "permanent";
  const entry = {
    outcome: status >= 500 ? "deferred" : "refused",
    error_code: error.code,
    error_class: errorClass,
    status,
    method: req.method,
    path: req.route?.path ?? req.path,
    actor_id: req.session?.dropship?.memberId ?? null,
    ...catalogLineCorrelation(req, res, error),
  };
  if (error.code === DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired) {
    logger.info("dropship.selection.rules_retired_refused", entry);
  } else if (errorClass === "fatal" || status === 500) {
    logger.error("dropship.vendor_catalog.request_failed", { ...entry, outcome: "failed" });
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
  // The picks save (PLAN-B v4.1 §14): every code it answers is named here, none falls to the default.
  if (code === SELECTION_CHANGE_ERROR_CODES.invalidInput || code === SELECTION_CHANGE_ERROR_CODES.conflicting) {
    return 400;
  }
  if (
    code === SELECTION_CHANGE_ERROR_CODES.revisionConflict
    || code === SELECTION_CHANGE_ERROR_CODES.effectsChanged
    // A DropshipError the save throws after its retries (SAFETY-3): a plain lock timeout, 40P01 or 40001 never reaches the 500.
    || code === SELECTION_CHANGE_ERROR_CODES.busy
    // PR C (PLAN-C v4.1 §4.1): an older page's preview or save; the page offers Reload.
    || code === SELECTION_CHANGE_ERROR_CODES.pageOutdated
  ) {
    return 409;
  }
  // PR C (§4.2, FID-4): a removal over the facts or end bound has its own code and words.
  if (code === SELECTION_CHANGE_ERROR_CODES.tooLarge || code === SELECTION_CHANGE_ERROR_CODES.removalTooLarge) {
    return 422;
  }
  // The save's reads disagree with each other, or a plan moved past every retry: the server's fault, never the page's.
  if (code === "DROPSHIP_SELECTION_COUNT_INCONSISTENT" || code === SELECTION_CHANGE_PLAN_MOVED) {
    return 500;
  }
  // The new-items notice (PLAN-B v4.1 §14): a refused "Got it" or a malformed notice request; the page reads the notice again.
  if (
    code === DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid
    || code === DROPSHIP_CATALOG_READ_ERROR_CODES.newItemsInvalidInput
  ) {
    return 400;
  }
  // A ledger row or a stored payload broke its contract: the server's fault, never the page's.
  if (code === CATALOG_ARRIVALS_ERROR_CODES.invariantFailed) {
    return 500;
  }
  // Two saved listing configurations or rows for one store size: data the vendor cannot fix (as the configuration codes below).
  if (code === "DROPSHIP_STOCK_SELECTION_AMBIGUOUS") {
    return 409;
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
