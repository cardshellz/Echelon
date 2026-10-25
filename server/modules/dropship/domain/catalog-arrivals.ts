import { z } from "zod";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureRule,
  type DropshipCatalogExposureSubject,
} from "./catalog-exposure";
import { isDatabaseUnavailableError } from "./database-unavailable-error";
import { DropshipError } from "./errors";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "../../../../shared/dropship/vendor-catalog-reads";

/**
 * The new-items notice's pure rules (step 1 plan S2-5, PR B; PLAN-B v4.1
 * §11.1, §11.3, §11.4, §13, §14): which catalog sizes are arrivals, the
 * first-mark rule, "new for a vendor", the grouping by category, the daily
 * email key and words, the conversion notice words, the "Got it" decision and
 * the job's error classes. No I/O; every time is the caller's injected clock.
 *
 * Vocabulary. An arrival is one row of `dropship.dropship_catalog_arrivals`:
 * a sellable size Card Shellz offers, first seen in a category (a size moved
 * to another category arrives again there; moved back, it does not). A mark
 * (`dropship.dropship_vendor_category_notice_marks`) holds, per vendor and
 * category, how far the vendor has seen the arrivals in step 1
 * (`seen_through_arrival_id`) and how far they were emailed
 * (`notified_through_arrival_id`).
 */

/** The ledger stage runs at most this often in one process (§11.1); the follow-up stage runs every tick. */
export const CATALOG_ARRIVALS_LEDGER_INTERVAL_MS = 60 * 60 * 1000;
/** Consecutive failed ticks (or failed follow-ups of one vendor) that make one ERROR (§11.1, §11.2; CLAUDE.md §6). */
export const CATALOG_JOB_FAILURE_ALERT_STREAK = 3;
/** The email names at most this many categories, then "and {k} more categories" (§13 noticeMore). */
export const CATALOG_NEW_ITEMS_EMAIL_CATEGORIES_SHOWN = 20;
/** The path of step 1 under the portal URL (client/src/lib/dropship-catalog-steps.ts catalogStepPath("choose")). */
export const CATALOG_CHOOSE_PORTAL_PATH = "catalog/choose";

/** §14 codes of the arrivals job, the conversion follow-up and the "Got it" refusal. */
export const CATALOG_ARRIVALS_ERROR_CODES = {
  tickFailed: "DROPSHIP_CATALOG_ARRIVALS_TICK_FAILED",
  followUpFailed: "DROPSHIP_SELECTION_CONVERSION_FOLLOWUP_FAILED",
  followUpRequiresReview: "DROPSHIP_SELECTION_CONVERSION_FOLLOWUP_REQUIRES_REVIEW",
  /** The page reads these two from the shared read contract, so a rename on one side cannot break the other. */
  acknowledgeInvalid: DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid,
  newItemsInvalidInput: DROPSHIP_CATALOG_READ_ERROR_CODES.newItemsInvalidInput,
  /** A row or a stored payload broke its contract (a programming or data fault): fatal. */
  invariantFailed: "DROPSHIP_CATALOG_ARRIVALS_INVARIANT_FAILED",
} as const;

const NEW_ITEMS_KEY_PREFIX = "catalog-new-items:";
const RULES_CONVERTED_KEY_PREFIX = "selection-rules-converted:";
/** `toISOString()` is always UTC; years 0-9999 print four digits, so the day is its first 10 characters. */
const UTC_DAY_LENGTH = 10;
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** What the ledger and "new for V" read of a size: the exposure subject plus the product's category id. */
export interface CatalogArrivalSubject extends DropshipCatalogExposureSubject {
  /** `catalog.products.category_id`; null when the product has none (never an arrival). */
  categoryId: number | null;
}

/** A ledger row to insert. */
export interface CatalogArrivalInsert {
  productVariantId: number;
  productId: number;
  categoryId: number;
}

/** One arrival as "new for V" reads it, with the vendor's facts of that size as columns of the same row. */
export interface CatalogArrivalFact {
  arrivalId: number;
  productVariantId: number;
  productId: number;
  categoryId: number;
  baseline: boolean;
  /** The vendor picked this size. */
  picked: boolean;
  /** The vendor's override turns this size off (`enabled_override = false`). */
  turnedOff: boolean;
}

/** One category of the notice: what the GET answers and what the email lists. */
export interface CatalogNewItemsCategory {
  categoryId: number;
  categoryName: string;
  /** Distinct products among the new sizes. */
  productCount: number;
  /** New sizes ("items" in the words). */
  sizeCount: number;
  /** The highest new arrival id in this category: "Got it" and the email move the marks up to it. */
  throughArrivalId: number;
}

/** A mark's two watermarks. */
export interface CatalogNoticeMark {
  categoryId: number;
  seenThroughArrivalId: number;
  notifiedThroughArrivalId: number;
}

/** Whether the hourly ledger stage is due: never run in this process, or an interval has passed (injected clock). */
export function isLedgerStageDue(lastRunAt: Date | null, now: Date): boolean {
  if (lastRunAt === null) return true;
  return now.getTime() - lastRunAt.getTime() >= CATALOG_ARRIVALS_LEDGER_INTERVAL_MS;
}

/**
 * Which read sizes enter the ledger (§11.1 stage 2): exposed by Card Shellz's
 * admin rules now (the injected clock; a rule that starts later admits its
 * sizes only once it is effective) and in a category. The reader already
 * kept only sellable sizes. Ascending by size id, so identity ids follow the
 * catalog's order.
 */
export function ledgerArrivalsFromSubjects(
  subjects: readonly CatalogArrivalSubject[],
  exposureRules: readonly DropshipCatalogExposureRule[],
  now: Date,
): CatalogArrivalInsert[] {
  return subjects
    .filter((subject) => subject.categoryId !== null && evaluateDropshipCatalogExposure(subject, exposureRules, now).exposed)
    .map((subject) => ({ productVariantId: subject.productVariantId, productId: subject.productId, categoryId: subject.categoryId! }))
    .sort((left, right) => left.productVariantId - right.productVariantId);
}

/**
 * The first-mark rule (§11.1 stage 3): each category the vendor sells from
 * that has no mark gets one at the ledger's highest arrival id, for both
 * watermarks, silently. So a vendor's first pick in a category never
 * surfaces the arrivals already there (FIDELITY-5). Unique, ascending.
 */
export function planFirstMarks(input: {
  sellFromCategoryIds: readonly number[];
  markedCategoryIds: ReadonlySet<number>;
  maxArrivalId: number;
}): Array<{ categoryId: number; throughArrivalId: number }> {
  return [...new Set(input.sellFromCategoryIds)]
    .filter((categoryId) => !input.markedCategoryIds.has(categoryId))
    .sort((left, right) => left - right)
    .map((categoryId) => ({ categoryId, throughArrivalId: input.maxArrivalId }));
}

/**
 * "New for V in C" (§11.1 stage 3, §11.4): an arrival in C past the
 * vendor's watermark for C, not part of the baseline, whose size is still
 * sellable (the subject exists: the reader keeps sellable sizes only), still
 * in C, exposed now, not turned off for the vendor and not picked by them. A
 * new size of a product the vendor already sells counts (v3 Q1 default). No
 * watermark for C (no mark) means nothing in C is new (FIDELITY-5).
 * Ascending by arrival id.
 */
export function decideNewForVendor(input: {
  arrivals: readonly CatalogArrivalFact[];
  /** categoryId → the watermark compared with (`notified_through` for the email, `seen_through` for step 1). */
  watermarks: ReadonlyMap<number, number>;
  subjects: ReadonlyMap<number, CatalogArrivalSubject>;
  exposureRules: readonly DropshipCatalogExposureRule[];
  now: Date;
}): CatalogArrivalFact[] {
  const fresh = input.arrivals.filter((arrival) => {
    const watermark = input.watermarks.get(arrival.categoryId);
    if (watermark === undefined || arrival.arrivalId <= watermark) return false;
    if (arrival.baseline || arrival.picked || arrival.turnedOff) return false;
    const subject = input.subjects.get(arrival.productVariantId);
    if (!subject || subject.categoryId !== arrival.categoryId) return false;
    return evaluateDropshipCatalogExposure(subject, input.exposureRules, input.now).exposed;
  });
  return [...fresh].sort((left, right) => left.arrivalId - right.arrivalId);
}

/**
 * The new sizes by category (§11.4's answer, the email's list): counts and
 * the highest arrival id per category, by name, then id. A category whose
 * name could not be read (deleted between the reads) is left out, so its
 * mark is not moved and it is counted on a later read.
 */
export function groupNewItems(
  newArrivals: readonly CatalogArrivalFact[],
  categoryNames: ReadonlyMap<number, string>,
): CatalogNewItemsCategory[] {
  const byCategory = new Map<number, { products: Set<number>; sizes: number; through: number }>();
  for (const arrival of newArrivals) {
    const group = byCategory.get(arrival.categoryId) ?? { products: new Set<number>(), sizes: 0, through: 0 };
    group.products.add(arrival.productId);
    group.sizes += 1;
    group.through = Math.max(group.through, arrival.arrivalId);
    byCategory.set(arrival.categoryId, group);
  }
  const categories: CatalogNewItemsCategory[] = [];
  for (const [categoryId, group] of byCategory) {
    const categoryName = categoryNames.get(categoryId);
    if (categoryName === undefined) continue;
    categories.push({ categoryId, categoryName, productCount: group.products.size, sizeCount: group.sizes,
      throughArrivalId: group.through });
  }
  return categories.sort((left, right) => left.categoryName.localeCompare(right.categoryName, "en")
    || left.categoryId - right.categoryId);
}

/** The UTC calendar day of the injected clock, `YYYY-MM-DD`; an invalid time is a programming fault (fatal). */
export function utcDayOf(now: Date): string {
  const day = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString().slice(0, UTC_DAY_LENGTH) : null;
  if (day === null || !UTC_DAY_PATTERN.test(day)) {
    throw invariantFailed("The catalog arrivals job was given a time it cannot name a day by.", {
      now: day === null ? null : now.toISOString(),
    });
  }
  return day;
}

/**
 * Today's email key (§11.1 stage 4; FIDELITY-2): at most one new-items email
 * per vendor per UTC day. The vendor id is in the key: the notification
 * idempotency index is global per (key, channel) (0097:45-47; V41).
 */
export function catalogNewItemsIdempotencyKey(vendorId: number, now: Date): string {
  return `${NEW_ITEMS_KEY_PREFIX}${vendorId}:${utcDayOf(now)}`;
}

/** A UTC day's length: UTC has no daylight saving, and JavaScript time counts no leap seconds. */
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The previous UTC day's key (JOB-2): the stage looks it up when nothing is
 * stored under today's, so an email whose mark move was lost in the last hour
 * of its day (a failed statement, a restart) still moves the marks to what it
 * named before the next day's email is read. One day back only.
 */
export function previousDayCatalogNewItemsIdempotencyKey(vendorId: number, now: Date): string {
  return catalogNewItemsIdempotencyKey(vendorId, new Date(now.getTime() - UTC_DAY_MS));
}

/** The conversion notice's key (§11.2 d): one notice per vendor, ever. */
export function selectionRulesConvertedIdempotencyKey(vendorId: number): string {
  return `${RULES_CONVERTED_KEY_PREFIX}${vendorId}`;
}

/** The stored email payload (§11.1 stage 4): what a later tick of the same day moves the marks to. */
export interface CatalogNewItemsPayload {
  /** The highest arrival id the email names, over every category. */
  throughArrivalId: number;
  categories: Array<{ categoryId: number; categoryName: string; productCount: number; sizeCount: number; throughArrivalId: number }>;
}

const nonNegativeIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const storedPayloadSchema = z.object({
  throughArrivalId: nonNegativeIdSchema,
  categories: z.array(z.object({
    categoryId: z.number().int().positive(),
    throughArrivalId: nonNegativeIdSchema,
  }).passthrough()).min(1),
}).passthrough();

export function catalogNewItemsPayload(categories: readonly CatalogNewItemsCategory[]): CatalogNewItemsPayload {
  if (categories.length === 0) throw invariantFailed("A new-items email was built with no category.");
  return {
    throughArrivalId: Math.max(...categories.map((category) => category.throughArrivalId)),
    categories: categories.map((category) => ({ ...category })),
  };
}

/**
 * The marks a stored email of today names, each with the arrival id it was
 * emailed through (§11.1 stage 4, "events stored"). A payload that fails its
 * own contract is a fault (fatal for that vendor), never guessed at.
 */
export function marksNamedByStoredPayload(payload: unknown): Array<{ categoryId: number; throughArrivalId: number }> {
  const parsed = storedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw invariantFailed("A stored new-items email payload failed its contract.", {
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  return parsed.data.categories.map((category) => ({ categoryId: category.categoryId, throughArrivalId: category.throughArrivalId }))
    .sort((left, right) => left.categoryId - right.categoryId);
}

/**
 * Step 1's address in the email: `DROPSHIP_PORTAL_URL || VENDOR_PORTAL_URL`
 * (dropship-wallet.routes.ts parsePortalBaseUrl) plus `catalog/choose`. Null
 * when unset or not an absolute http(s) URL: the words then name the portal.
 */
export function catalogChooseUrl(portalBaseUrl: string | null | undefined): string | null {
  const trimmed = portalBaseUrl?.trim();
  if (!trimmed) return null;
  let base: URL;
  try {
    base = new URL(trimmed);
  } catch {
    // Deliberate: a malformed setting means "no URL" (the words without a link), not a failed email.
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  return new URL(CATALOG_CHOOSE_PORTAL_PATH, base).toString();
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** §13 noticeEmailTitle and noticeEmailBody, with the categories listed as "Name (n)". */
export function describeCatalogNewItemsEmail(input: {
  categories: readonly CatalogNewItemsCategory[];
  catalogUrl: string | null;
}): { title: string; message: string } {
  if (input.categories.length === 0) throw invariantFailed("A new-items email was described with no category.");
  const shown = input.categories.slice(0, CATALOG_NEW_ITEMS_EMAIL_CATEGORIES_SHOWN)
    .map((category) => `${category.categoryName} (${formatCount(category.sizeCount)})`).join(", ");
  const more = input.categories.length - CATALOG_NEW_ITEMS_EMAIL_CATEGORIES_SHOWN;
  const list = more > 0
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    ? `${shown} and ${formatCount(more)} more ${more === 1 ? "category" : "categories"}`
    : shown;
  return {
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    title: "New items from Card Shellz",
    message: input.catalogUrl === null
      // Stage 3/5 (step 1 plan S2-5): PROPOSED.
      ? `Card Shellz added new items in categories you sell from: ${list}. Nothing is added until you choose them in Catalog, step 1 (Choose what to sell), in your Card Shellz dropship portal, and publish them in step 3.`
      // Stage 3/5 (step 1 plan S2-5): PROPOSED.
      : `Card Shellz added new items in categories you sell from: ${list}. Nothing is added until you choose them in Catalog, step 1 (Choose what to sell), and publish them in step 3: ${input.catalogUrl}`,
  };
}

/** §13 convertedTitle and convertedBody; `n` is the vendor's selected count after the follow-up. */
export function describeSelectionRulesConvertedNotice(selectedCount: number): { title: string; message: string } {
  if (!Number.isSafeInteger(selectedCount) || selectedCount < 0) {
    throw invariantFailed("The conversion notice was given a count that is not a whole number of items.", { selectedCount });
  }
  const covered = selectedCount === 1
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    ? "The 1 item it covered today stays chosen."
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    : `The ${formatCount(selectedCount)} items it covered today stay chosen.`;
  return {
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    title: "Your automatic choices were turned into items",
    // Stage 3/5 (step 1 plan S2-5): PROPOSED.
    message: `Your setting that added new items by itself (for a category, a product or everything) has been replaced. ${covered} When Card Shellz adds new items to a category you sell from, you'll see them in Catalog, step 1, and nothing is added until you choose it.`,
  };
}

export type CatalogAcknowledgeDecision =
  | { kind: "invalid" }
  | { kind: "already_seen" }
  | { kind: "advance"; seenThroughArrivalId: number; notifiedThroughArrivalId: number };

/**
 * "Got it" (§11.4): both watermarks move to GREATEST(existing, through); a
 * missing mark is created at `through`. Idempotent by state: a mark already
 * at or past `through` on both is `already_seen` (no write, no audit). A
 * `through` past the ledger's highest arrival id is refused.
 */
export function decideAcknowledge(input: {
  mark: Pick<CatalogNoticeMark, "seenThroughArrivalId" | "notifiedThroughArrivalId"> | null;
  throughArrivalId: number;
  maxArrivalId: number;
}): CatalogAcknowledgeDecision {
  if (input.throughArrivalId > input.maxArrivalId) return { kind: "invalid" };
  if (input.mark && input.mark.seenThroughArrivalId >= input.throughArrivalId
    && input.mark.notifiedThroughArrivalId >= input.throughArrivalId) {
    return { kind: "already_seen" };
  }
  return {
    kind: "advance",
    seenThroughArrivalId: Math.max(input.mark?.seenThroughArrivalId ?? input.throughArrivalId, input.throughArrivalId),
    notifiedThroughArrivalId: Math.max(input.mark?.notifiedThroughArrivalId ?? input.throughArrivalId, input.throughArrivalId),
  };
}

/**
 * The job's error classes (CLAUDE.md §6; §11.1, §11.2, §14):
 * - `busy`: the publication gate or a row lock was held (55P03), a deadlock
 *   (40P01), a serialization failure (40001), or the database connection was
 *   lost or unavailable: expected under load, retried later, never a streak.
 * - `transient`: a DropshipError classified transient (a mapped database
 *   failure) or a statement timeout (57014): retried, counted in the streak.
 * - `permanent`: a refusal (a DropshipError classified permanent, or with no
 *   class: a deliberate refusal is not retried), an integrity violation
 *   (SQLSTATE class 23) or a raised exception (P0001): never retried.
 * - `fatal`: anything else (a fault): it needs a human.
 */
export type CatalogJobErrorClass = "busy" | "transient" | "permanent" | "fatal";

const BUSY_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01", "40001"]);
const STATEMENT_TIMEOUT_SQLSTATE = "57014";
const RAISED_EXCEPTION_SQLSTATE = "P0001";

export function classifyCatalogJobError(error: unknown): { errorClass: CatalogJobErrorClass; code: string | null } {
  if (error instanceof DropshipError) {
    const classification = error.context?.classification;
    const errorClass: CatalogJobErrorClass = classification === "transient" ? "transient"
      : classification === "fatal" ? "fatal" : "permanent";
    return { errorClass, code: error.code };
  }
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const sqlState = typeof code === "string" && code.length > 0 ? code : null;
  if (sqlState !== null && BUSY_SQLSTATES.has(sqlState)) return { errorClass: "busy", code: sqlState };
  if (isDatabaseUnavailableError(error)) return { errorClass: "busy", code: sqlState };
  if (sqlState === STATEMENT_TIMEOUT_SQLSTATE) return { errorClass: "transient", code: sqlState };
  if (sqlState !== null && (sqlState.startsWith("23") || sqlState === RAISED_EXCEPTION_SQLSTATE)) {
    return { errorClass: "permanent", code: sqlState };
  }
  return { errorClass: "fatal", code: sqlState };
}

/** A broken contract inside the job: fatal (CLAUDE.md §6). */
export function invariantFailed(message: string, context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError(CATALOG_ARRIVALS_ERROR_CODES.invariantFailed, message, {
    ...context, retryable: false, classification: "fatal",
  });
}
