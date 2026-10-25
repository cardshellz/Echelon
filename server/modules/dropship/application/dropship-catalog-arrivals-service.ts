import { z } from "zod";
import {
  CATALOG_ARRIVALS_ERROR_CODES,
  CATALOG_JOB_FAILURE_ALERT_STREAK,
  catalogNewItemsIdempotencyKey,
  catalogNewItemsPayload,
  classifyCatalogJobError,
  decideAcknowledge,
  decideNewForVendor,
  describeCatalogNewItemsEmail,
  groupNewItems,
  invariantFailed,
  isLedgerStageDue,
  ledgerArrivalsFromSubjects,
  marksNamedByStoredPayload,
  planFirstMarks,
  previousDayCatalogNewItemsIdempotencyKey,
  type CatalogArrivalFact,
  type CatalogArrivalInsert,
  type CatalogArrivalSubject,
  type CatalogNewItemsCategory,
  type CatalogNoticeMark,
} from "../domain/catalog-arrivals";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { isCatalogAccessBlockedVendorStatus } from "../domain/vendor-standing";
import type { ConversionFollowUpStageResult } from "./dropship-selection-conversion-followup";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipClock } from "./dropship-ports";

/**
 * The new-items notice job (step 1 plan S2-5, PR B; PLAN-B v4.1 §11.1,
 * §11.3, §11.4). One tick a minute, under the runner's advisory lock
 * (dropship-catalog-arrivals-runner.ts), in this order:
 * 1. the conversion follow-up (every tick; dropship-selection-conversion-followup.ts);
 * 2. the ledger (at most hourly in this process): every sellable size Card
 *    Shellz offers now in a category becomes an arrival once. While the
 *    ledger is empty the whole first run is the baseline, one transaction,
 *    all or nothing, announcing nothing (CHK6);
 * 3. per vendor with a pick that may open the catalog (not closed, lapsed or
 *    suspended: DROPSHIP_CATALOG_ACCESS_BLOCKED_VENDOR_STATUSES, the list
 *    step 1's own access check refuses; JOB-1): a silent first mark for each
 *    category it sells from that has none;
 * 4. per vendor: at most one email a UTC day naming the new items in those
 *    categories. Today's key is looked up first, so a second tick of the
 *    same day never sends again and only moves the marks to what was
 *    emailed (FIDELITY-2); with nothing under it, the previous day's key
 *    moves the marks the same way before today's items are read, so a move
 *    lost in a day's last hour never repeats an item (JOB-2). The email is a
 *    deliberate side channel; step 1 reads the ledger itself (readNewItems).
 * Stages 3 and 4 follow the ledger stage and do not run while the ledger is
 * empty. Nothing here adds a pick: only the vendor's save does (decision 3).
 *
 * The tick's failure classes (CLAUDE.md §6; FIDELITY-4): a transient
 * failure (the database busy or unreachable, a lock timeout, a deadlock, a
 * serialization failure, a statement timeout) is WARN and the next tick
 * tries again; three failed ticks in a row make one ERROR
 * DROPSHIP_CATALOG_ARRIVALS_TICK_FAILED; any other failure is fatal for the
 * tick (ERROR at once; the next tick tries again: the ledger stage is all or
 * nothing). One vendor's failure in stages 3-4 skips that vendor only.
 */

/** Sizes the ledger reads and decides at a time. */
export const CATALOG_ARRIVALS_LEDGER_BATCH_SIZE = 1_000;
/** Each statement of the baseline transaction may run this long (§11.1 stage 2: `SET LOCAL statement_timeout = '5min'`). */
export const CATALOG_ARRIVALS_BASELINE_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000;
/** A log line names at most this many ids, with the full count beside it. */
const MAX_LOGGED_IDS = 100;
const NOTIFICATION_IDEMPOTENCY_CONFLICT = "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT";
const VENDOR_NOTICE_FAILED_CODE = "DROPSHIP_CATALOG_ARRIVALS_VENDOR_FAILED";

/** The ledger's reads and writes, on one transaction's client or on the pool. */
export interface CatalogArrivalsLedgerSession {
  /** Every sellable size after `afterId`, ascending (dropship-selected-catalog.reader.ts listSellableVariantIdsAfter). */
  listSellableVariantIdsAfter(afterId: number, limit: number): Promise<number[]>;
  /** These sizes' exposure facts and category, sellable sizes only. */
  readArrivalSubjects(productVariantIds: readonly number[]): Promise<CatalogArrivalSubject[]>;
  listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]>;
  ledgerIsEmpty(): Promise<boolean>;
  /** ON CONFLICT (size, category) DO NOTHING. Returns the rows inserted. */
  insertArrivals(input: { rows: readonly CatalogArrivalInsert[]; baseline: boolean; now: Date }): Promise<number>;
}

/** What "new for V" is decided from, read in one snapshot for the asked categories. */
export interface CatalogNewForVendorFacts {
  /** The vendor's marks among the asked categories (a category without a mark has nothing new). */
  marks: CatalogNoticeMark[];
  /** Arrivals of the marked categories past the asked watermark, with the vendor's pick and override as columns. */
  arrivals: CatalogArrivalFact[];
  /** Those arrivals' sizes that are still sellable. */
  subjects: CatalogArrivalSubject[];
  exposureRules: DropshipCatalogExposureRule[];
  categoryNames: Array<{ categoryId: number; name: string }>;
}

/** "Got it" in one transaction (§11.4). */
export interface CatalogAcknowledgeTransaction {
  readMaxArrivalId(): Promise<number>;
  /** The vendor's mark of the category, `FOR UPDATE`; null when there is none. */
  lockMark(input: { vendorId: number; categoryId: number }): Promise<CatalogNoticeMark | null>;
  /** Upsert with both watermarks GREATEST(existing, given). True when a row changed. */
  upsertMark(input: {
    vendorId: number; categoryId: number; seenThroughArrivalId: number; notifiedThroughArrivalId: number; now: Date;
  }): Promise<boolean>;
  insertAudit(input: {
    vendorId: number; categoryId: number; actor: { actorType: "vendor"; actorId: string };
    payload: Record<string, unknown>; now: Date;
  }): Promise<void>;
}

export interface DropshipCatalogArrivalsRepository {
  /** BEGIN, SET LOCAL statement_timeout, `work`, COMMIT; on any error ROLLBACK and rethrow (the baseline, CHK6). */
  runLedgerTransaction<T>(input: { statementTimeoutMs: number }, work: (session: CatalogArrivalsLedgerSession) => Promise<T>): Promise<T>;
  /** The same session on the pool: every statement commits by itself (a later run commits per batch). */
  ledgerOnPool(): CatalogArrivalsLedgerSession;
  /** The ledger's highest arrival id; 0 when it is empty. */
  readMaxArrivalId(): Promise<number>;
  /** Vendors with at least one pick, ascending, each with its status (the service leaves out those step 1 refuses). */
  listVendorsWithPicks(): Promise<Array<{ vendorId: number; status: string }>>;
  /** The categories of the vendor's selected sizes, ascending, in one read-only snapshot (SEL's scan). */
  readSellFromCategoryIds(input: { vendorId: number; now: Date }): Promise<number[]>;
  listMarks(vendorId: number): Promise<CatalogNoticeMark[]>;
  /** ON CONFLICT DO NOTHING: an existing mark is never changed. Returns the marks inserted. */
  insertFirstMarks(input: {
    vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }>; now: Date;
  }): Promise<number>;
  readNewForVendorFacts(input: {
    vendorId: number; categoryIds: readonly number[]; watermark: "notified" | "seen";
  }): Promise<CatalogNewForVendorFacts>;
  /** One statement: each named mark's `notified_through` to GREATEST(itself, given). Returns the marks moved. */
  advanceNotifiedMarks(input: {
    vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }>; now: Date;
  }): Promise<number>;
  /** BEGIN, `work`, COMMIT; ROLLBACK and rethrow on any error. */
  runAcknowledge<T>(work: (tx: CatalogAcknowledgeTransaction) => Promise<T>): Promise<T>;
}

/** The notification service's two calls the job makes (dropship-notification-service.ts). */
export interface CatalogArrivalsNotifications {
  listEventsByKey(input: { vendorId: number; idempotencyKey: string }): Promise<ReadonlyArray<{ payload: Record<string, unknown> }>>;
  send(input: {
    vendorId: number; eventType: string; critical: boolean; title: string; message: string;
    payload: Record<string, unknown>; idempotencyKey: string;
  }): Promise<{ events: readonly unknown[]; idempotentReplay: boolean }>;
}

/** The follow-up stage (dropship-selection-conversion-followup.ts). */
export interface CatalogConversionFollowUpStage {
  runStage(now: Date): Promise<ConversionFollowUpStageResult>;
}

/** The job's lines through the platform logger (CLAUDE.md §10): `action` plus structured fields, DEBUG included. */
export interface CatalogJobLog {
  debug(action: string, fields: Record<string, unknown>): void;
  info(action: string, fields: Record<string, unknown>): void;
  warn(action: string, fields: Record<string, unknown>): void;
  error(action: string, fields: Record<string, unknown>): void;
}

export interface DropshipCatalogArrivalsServiceDependencies {
  repository: DropshipCatalogArrivalsRepository;
  notifications: CatalogArrivalsNotifications;
  followUp: CatalogConversionFollowUpStage;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only. */
  timer: () => number;
  log: CatalogJobLog;
  /** Step 1's address for the email (catalogChooseUrl), or null for the words without a link. */
  catalogUrl: string | null;
}

export interface CatalogArrivalsLedgerStageResult {
  baseline: boolean;
  insertedCount: number;
  /** The ledger holds no arrival after this stage (an empty catalog): stages 3-4 did not run. */
  ledgerEmpty: boolean;
}

export interface CatalogArrivalsNoticeStageResult {
  vendorsScanned: number;
  /** Vendors with a pick that may not open the catalog: no first mark, no email (JOB-1). */
  vendorsBlocked: number;
  vendorsFailed: number;
  firstMarksInserted: number;
  vendorsEmailed: number;
  vendorsAlreadyEmailedToday: number;
}

export interface CatalogArrivalsTickResult {
  outcome: "completed" | "failed";
  followUp: ConversionFollowUpStageResult | null;
  ledger: CatalogArrivalsLedgerStageResult | null;
  notices: CatalogArrivalsNoticeStageResult | null;
  elapsedMs: number;
}

export interface CatalogNewItemsAnswer {
  categories: CatalogNewItemsCategory[];
}

export interface CatalogAcknowledgeAnswer {
  outcome: "acknowledged" | "already_seen";
  categoryId: number;
  seenThroughArrivalId: number;
}

const idSchema = z.number().int().positive().max(2_147_483_647);
const arrivalIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const acknowledgeInputSchema = z.object({
  vendorId: idSchema,
  actor: z.object({ actorType: z.literal("vendor"), actorId: z.string().trim().min(1).max(255) }).strict(),
  categoryId: idSchema,
  throughArrivalId: arrivalIdSchema,
}).strict();
const vendorInputSchema = z.object({ vendorId: idSchema }).strict();
const newVariantIdsInputSchema = z.object({ vendorId: idSchema, categoryId: idSchema.nullable(), now: z.date() }).strict();

/**
 * Explicitly stateful (CLAUDE.md §3): the hour of the last ledger stage and
 * the failed-tick streak live in this process. Each web process runs the
 * ledger stage at most once an hour when it holds the lock; another process
 * may run it again within the hour, which inserts nothing new (ON CONFLICT)
 * and moves no mark twice (GREATEST, today's key).
 */
export class DropshipCatalogArrivalsService {
  private lastLedgerRunAt: Date | null = null;
  private failedTicksInARow = 0;

  constructor(private readonly deps: DropshipCatalogArrivalsServiceDependencies) {}

  /** One tick. Never throws: every failure is classified and logged here, with the streak. */
  async runTick(): Promise<CatalogArrivalsTickResult> {
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    let followUp: ConversionFollowUpStageResult | null = null;
    let ledger: CatalogArrivalsLedgerStageResult | null = null;
    let notices: CatalogArrivalsNoticeStageResult | null = null;
    try {
      followUp = await this.deps.followUp.runStage(now);
      if (isLedgerStageDue(this.lastLedgerRunAt, now)) {
        ledger = await this.runLedgerStage(now);
        if (!ledger.ledgerEmpty) notices = await this.runNoticeStage(now);
        this.lastLedgerRunAt = now;
      }
    } catch (error) {
      this.recordTickFailure(error);
      return { outcome: "failed", followUp, ledger, notices, elapsedMs: this.elapsedSince(started) };
    }
    this.failedTicksInARow = 0;
    const result: CatalogArrivalsTickResult = { outcome: "completed", followUp, ledger, notices, elapsedMs: this.elapsedSince(started) };
    this.logTick(result);
    return result;
  }

  /**
   * A failed tick, by class (FIDELITY-4): transient → WARN, and one ERROR
   * when this is the third failed tick in a row; anything else → ERROR at
   * once. The runner hands the lock runner's own failures here too, so they
   * count in the same streak.
   */
  recordTickFailure(error: unknown, extra: Record<string, unknown> = {}): void {
    this.failedTicksInARow += 1;
    const { errorClass, code } = classifyCatalogJobError(error);
    const transient = errorClass === "busy" || errorClass === "transient";
    const fields = {
      ...extra,
      outcome: transient ? "deferred" : "failed",
      error_code: code ?? CATALOG_ARRIVALS_ERROR_CODES.tickFailed,
      error_class: transient ? "transient" : "fatal",
      failed_ticks_in_a_row: this.failedTicksInARow,
      ...errorDetail(error, !transient),
    };
    if (!transient) {
      this.deps.log.error("dropship.catalog_arrivals.tick_failed", fields);
      return;
    }
    this.deps.log.warn("dropship.catalog_arrivals.tick_failed", fields);
    if (this.failedTicksInARow === CATALOG_JOB_FAILURE_ALERT_STREAK) {
      // Three in a row: retrying alone has not fixed it, so a human is told once (CLAUDE.md §10: ERROR = needs a human).
      this.deps.log.error("dropship.catalog_arrivals.tick_failed", {
        ...fields, outcome: "failed", error_code: CATALOG_ARRIVALS_ERROR_CODES.tickFailed, cause_code: code,
      });
    }
  }

  /** Step 1's notice (§11.4): the new items of each category the vendor sells from, past its `seen_through` mark. Read only. */
  async readNewItems(input: unknown): Promise<CatalogNewItemsAnswer> {
    const { vendorId } = parseServiceInput(vendorInputSchema, input);
    const now = this.deps.clock.now();
    const fresh = await this.readFreshSinceSeen({ vendorId, categoryId: null, now });
    return { categories: fresh === null ? [] : groupNewItems(fresh.arrivals, fresh.categoryNames) };
  }

  /**
   * The catalog GET's `selection=new` (§11.4): the size ids `readNewItems`
   * counts, at the caller's time (the catalog read's own clock, so its rows
   * and these ids are decided at one time), in `categoryId` alone when given.
   * A category whose name could not be read is left out, as `readNewItems`
   * leaves it out, so the rows always equal the notice's counts (TESTS-8).
   * Ascending. Read only.
   */
  async listNewVariantIds(input: unknown): Promise<number[]> {
    const parsed = parseServiceInput(newVariantIdsInputSchema, input);
    const fresh = await this.readFreshSinceSeen(parsed);
    if (fresh === null) return [];
    return [...new Set(fresh.arrivals
      .filter((arrival) => fresh.categoryNames.has(arrival.categoryId))
      .map((arrival) => arrival.productVariantId))].sort((left, right) => left - right);
  }

  /**
   * The arrivals new for the vendor past `seen_through`, in the categories it
   * sells from (all of them, or only `categoryId`), with the categories'
   * names. Null when it sells from none of them (nothing is new).
   */
  private async readFreshSinceSeen(input: { vendorId: number; categoryId: number | null; now: Date }): Promise<{
    arrivals: CatalogArrivalFact[]; categoryNames: ReadonlyMap<number, string>;
  } | null> {
    const sellFrom = await this.deps.repository.readSellFromCategoryIds({ vendorId: input.vendorId, now: input.now });
    const categoryIds = input.categoryId === null ? sellFrom : sellFrom.filter((categoryId) => categoryId === input.categoryId);
    if (categoryIds.length === 0) return null;
    const facts = await this.deps.repository.readNewForVendorFacts({ vendorId: input.vendorId, categoryIds, watermark: "seen" });
    return freshArrivalsFromFacts(facts, "seen", input.now);
  }

  /**
   * "Got it" (§11.4): both watermarks of the vendor's category move to
   * GREATEST(existing, through), with the audit row, in one transaction;
   * idempotent by state (a second press answers `already_seen` and writes no
   * audit). A `through` past the newest arrival is refused (400).
   */
  async acknowledge(input: unknown): Promise<CatalogAcknowledgeAnswer> {
    const parsed = parseServiceInput(acknowledgeInputSchema, input);
    const now = this.deps.clock.now();
    // The route's answer, plus the mark as this transaction locked it and as it left it, for the log line only (API-1).
    const { answer, before, after } = await this.deps.repository.runAcknowledge(async (tx): Promise<{
      answer: CatalogAcknowledgeAnswer; before: AcknowledgeLogMark | null; after: AcknowledgeLogMark | null;
    }> => {
      const maxArrivalId = await tx.readMaxArrivalId();
      const mark = await tx.lockMark({ vendorId: parsed.vendorId, categoryId: parsed.categoryId });
      const locked = mark === null ? null : acknowledgeLogMark(mark.seenThroughArrivalId, mark.notifiedThroughArrivalId);
      const decision = decideAcknowledge({ mark, throughArrivalId: parsed.throughArrivalId, maxArrivalId });
      if (decision.kind === "invalid") {
        throw new DropshipError(CATALOG_ARRIVALS_ERROR_CODES.acknowledgeInvalid,
          // Not shown: the page reads the notice again on this code (§14).
          "The new-items notice was acknowledged past the newest Card Shellz arrival.", {
            vendorId: parsed.vendorId, categoryId: parsed.categoryId, throughArrivalId: parsed.throughArrivalId, maxArrivalId,
            classification: "permanent", retryable: false,
          });
      }
      // Nothing moved here: the mark is what this transaction locked (null when a racing press created it unseen).
      const alreadySeen = () => ({
        answer: {
          outcome: "already_seen", categoryId: parsed.categoryId,
          seenThroughArrivalId: Math.max(mark?.seenThroughArrivalId ?? 0, parsed.throughArrivalId),
        } as const,
        before: locked,
        after: locked,
      });
      if (decision.kind === "already_seen") return alreadySeen();
      const changed = await tx.upsertMark({
        vendorId: parsed.vendorId, categoryId: parsed.categoryId, seenThroughArrivalId: decision.seenThroughArrivalId,
        notifiedThroughArrivalId: decision.notifiedThroughArrivalId, now,
      });
      // A press that committed between the lock and the upsert (a missing mark both created) already moved it.
      if (!changed) return alreadySeen();
      await tx.insertAudit({
        vendorId: parsed.vendorId, categoryId: parsed.categoryId, actor: parsed.actor, now,
        payload: {
          categoryId: parsed.categoryId,
          throughArrivalId: parsed.throughArrivalId,
          before: mark === null ? null : { seenThroughArrivalId: mark.seenThroughArrivalId, notifiedThroughArrivalId: mark.notifiedThroughArrivalId },
          after: { seenThroughArrivalId: decision.seenThroughArrivalId, notifiedThroughArrivalId: decision.notifiedThroughArrivalId },
        },
      });
      return {
        answer: { outcome: "acknowledged", categoryId: parsed.categoryId, seenThroughArrivalId: decision.seenThroughArrivalId },
        before: locked,
        after: acknowledgeLogMark(decision.seenThroughArrivalId, decision.notifiedThroughArrivalId),
      };
    });
    const fields = {
      outcome: answer.outcome, vendor_id: parsed.vendorId, category_id: parsed.categoryId, actor_id: parsed.actor.actorId,
      through_arrival_id: parsed.throughArrivalId, before, after,
    };
    // A repeated press is expected (DEBUG); a moved mark is a state transition (INFO).
    if (answer.outcome === "acknowledged") this.deps.log.info("dropship.catalog_arrivals.acknowledged", fields);
    else this.deps.log.debug("dropship.catalog_arrivals.acknowledged", fields);
    return answer;
  }

  /** Stage 2: the baseline (one transaction) while the ledger is empty, else the new arrivals, committed per batch. */
  private async runLedgerStage(now: Date): Promise<CatalogArrivalsLedgerStageResult> {
    const pooled = this.deps.repository.ledgerOnPool();
    if (await pooled.ledgerIsEmpty()) {
      const insertedCount = await this.deps.repository.runLedgerTransaction(
        { statementTimeoutMs: CATALOG_ARRIVALS_BASELINE_STATEMENT_TIMEOUT_MS },
        async (session) => {
          // Under the runner lock no other process writes the ledger, so it is still empty here.
          if (!(await session.ledgerIsEmpty())) throw invariantFailed("The arrivals ledger filled while its baseline was starting.");
          return walkLedger(session, now, true);
        },
      );
      // §4.2 names this line: the first run writes baseline rows only and announces nothing.
      this.deps.log.info("dropship.catalog_arrivals.baseline_written", {
        outcome: insertedCount > 0 ? "written" : "empty_catalog", inserted_count: insertedCount,
      });
      return { baseline: true, insertedCount, ledgerEmpty: insertedCount === 0 };
    }
    const insertedCount = await walkLedger(pooled, now, false);
    return { baseline: false, insertedCount, ledgerEmpty: false };
  }

  /**
   * Stages 3-4 for every vendor with a pick that may open the catalog; one
   * vendor's failure skips that vendor only. A vendor step 1 refuses (closed,
   * lapsed, suspended) is left out whole: it cannot open the page the email
   * names or press Got it there (JOB-1). Its marks stay as they are, so once
   * it may open the catalog again it is first-marked silently where it has no
   * mark, and its next email names what arrived meanwhile, as step 1 shows.
   */
  private async runNoticeStage(now: Date): Promise<CatalogArrivalsNoticeStageResult> {
    const withPicks = await this.deps.repository.listVendorsWithPicks();
    const vendors = withPicks.filter((vendor) => !isCatalogAccessBlockedVendorStatus(vendor.status)).map((vendor) => vendor.vendorId);
    const blocked = withPicks.filter((vendor) => isCatalogAccessBlockedVendorStatus(vendor.status));
    if (blocked.length > 0) {
      // Expected and repeated every stage while a vendor stays blocked (CLAUDE.md §10): DEBUG.
      this.deps.log.debug("dropship.catalog_arrivals.vendors_blocked", {
        outcome: "skipped", vendor_count: blocked.length,
        vendors: blocked.slice(0, MAX_LOGGED_IDS).map((vendor) => ({ vendor_id: vendor.vendorId, vendor_status: vendor.status })),
      });
    }
    const maxArrivalId = await this.deps.repository.readMaxArrivalId();
    const result: CatalogArrivalsNoticeStageResult = {
      vendorsScanned: vendors.length, vendorsBlocked: blocked.length, vendorsFailed: 0, firstMarksInserted: 0, vendorsEmailed: 0,
      vendorsAlreadyEmailedToday: 0,
    };
    for (const vendorId of vendors) {
      try {
        const vendor = await this.noticeForVendor(vendorId, now, maxArrivalId);
        result.firstMarksInserted += vendor.firstMarksInserted;
        if (vendor.email === "sent") result.vendorsEmailed += 1;
        if (vendor.email === "already_emailed_today") result.vendorsAlreadyEmailedToday += 1;
      } catch (error) {
        result.vendorsFailed += 1;
        this.logVendorFailure(vendorId, error);
      }
    }
    return result;
  }

  private async noticeForVendor(vendorId: number, now: Date, maxArrivalId: number): Promise<{
    firstMarksInserted: number; email: "none" | "sent" | "already_emailed_today";
  }> {
    const sellFrom = await this.deps.repository.readSellFromCategoryIds({ vendorId, now });
    if (sellFrom.length === 0) return { firstMarksInserted: 0, email: "none" };

    // Stage 3: the first-mark rule, silently.
    const marks = await this.deps.repository.listMarks(vendorId);
    const firstMarks = planFirstMarks({
      sellFromCategoryIds: sellFrom, markedCategoryIds: new Set(marks.map((mark) => mark.categoryId)), maxArrivalId,
    });
    const firstMarksInserted = firstMarks.length === 0 ? 0
      : await this.deps.repository.insertFirstMarks({ vendorId, marks: firstMarks, now });
    if (firstMarksInserted > 0) {
      this.deps.log.debug("dropship.catalog_arrivals.first_marks", {
        outcome: "marked", vendor_id: vendorId, inserted_count: firstMarksInserted,
        category_ids: firstMarks.map((mark) => mark.categoryId).slice(0, MAX_LOGGED_IDS), through_arrival_id: maxArrivalId,
      });
    }

    // Stage 4: today's key first (FIDELITY-2).
    const idempotencyKey = catalogNewItemsIdempotencyKey(vendorId, now);
    const stored = await this.deps.notifications.listEventsByKey({ vendorId, idempotencyKey });
    if (stored.length > 0) {
      // Today's email went out; a crash may have lost the marks' move. Move them to what it named, send nothing.
      const named = mergeNamedMarks(stored.map((event) => marksNamedByStoredPayload(event.payload)));
      const moved = await this.deps.repository.advanceNotifiedMarks({ vendorId, marks: named, now });
      this.deps.log.debug("dropship.catalog_arrivals.already_emailed_today", {
        outcome: "skipped", vendor_id: vendorId, idempotency_key: idempotencyKey, marks_moved: moved,
      });
      return { firstMarksInserted, email: "already_emailed_today" };
    }
    // Nothing today: yesterday's email may have lost its move (its last hour, a restart; JOB-2). Move the marks to what
    // it named before reading today's items, so none of them is emailed twice. Forward only: normally it moves nothing.
    const previousKey = previousDayCatalogNewItemsIdempotencyKey(vendorId, now);
    const previous = await this.deps.notifications.listEventsByKey({ vendorId, idempotencyKey: previousKey });
    if (previous.length > 0) {
      const repaired = await this.deps.repository.advanceNotifiedMarks({
        vendorId, marks: mergeNamedMarks(previous.map((event) => marksNamedByStoredPayload(event.payload))), now,
      });
      if (repaired > 0) {
        // The lost move itself was logged when it failed (vendor_failed); this is its repair.
        this.deps.log.debug("dropship.catalog_arrivals.previous_email_marks_moved", {
          outcome: "repaired", vendor_id: vendorId, idempotency_key: previousKey, marks_moved: repaired,
        });
      }
    }

    const facts = await this.deps.repository.readNewForVendorFacts({ vendorId, categoryIds: sellFrom, watermark: "notified" });
    const categories = newItemsFromFacts(facts, "notified", now);
    if (categories.length === 0) return { firstMarksInserted, email: "none" };

    const words = describeCatalogNewItemsEmail({ categories, catalogUrl: this.deps.catalogUrl });
    const payload = catalogNewItemsPayload(categories);
    // Stored under today's key before delivery (NR); a muted vendor stores nothing and the marks still move.
    const sent = await this.deps.notifications.send({
      vendorId, eventType: DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS, critical: false, title: words.title,
      message: words.message, payload: { ...payload }, idempotencyKey,
    });
    const moved = await this.deps.repository.advanceNotifiedMarks({
      vendorId, marks: categories.map((category) => ({ categoryId: category.categoryId, throughArrivalId: category.throughArrivalId })), now,
    });
    this.deps.log.info("dropship.catalog_arrivals.new_items_emailed", {
      outcome: sent.events.length > 0 ? "sent" : "muted",
      vendor_id: vendorId,
      idempotency_key: idempotencyKey,
      category_count: categories.length,
      size_count: categories.reduce((sum, category) => sum + category.sizeCount, 0),
      through_arrival_id: payload.throughArrivalId,
      marks_moved: moved,
      after: { notified_through: categories.map((category) => [category.categoryId, category.throughArrivalId]).slice(0, MAX_LOGGED_IDS) },
    });
    return { firstMarksInserted, email: "sent" };
  }

  /**
   * One vendor's failed notice, by class: a key conflict can only come from a
   * second writer of today's key, which the runner lock excludes (transient:
   * nothing moved, the next run takes the "events stored" branch); a busy or
   * transient database is WARN; anything else needs a human (ERROR). The
   * next ledger stage (an hour later) tries the vendor again.
   */
  private logVendorFailure(vendorId: number, error: unknown): void {
    const keyConflict = error instanceof DropshipError && error.code === NOTIFICATION_IDEMPOTENCY_CONFLICT;
    const { errorClass, code } = classifyCatalogJobError(error);
    const transient = keyConflict || errorClass === "busy" || errorClass === "transient";
    const fields = {
      outcome: transient ? "deferred" : "failed",
      vendor_id: vendorId,
      error_code: code ?? VENDOR_NOTICE_FAILED_CODE,
      error_class: transient ? "transient" : errorClass,
      ...errorDetail(error, !transient),
    };
    if (transient) this.deps.log.warn("dropship.catalog_arrivals.vendor_failed", fields);
    else this.deps.log.error("dropship.catalog_arrivals.vendor_failed", fields);
  }

  private logTick(result: CatalogArrivalsTickResult): void {
    const followUpActed = result.followUp !== null
      && (result.followUp.followUpsDone > 0 || result.followUp.noticesSent > 0 || result.followUp.vendorsFailed > 0);
    const ledgerActed = result.ledger !== null && (result.ledger.baseline || result.ledger.insertedCount > 0);
    const noticesActed = result.notices !== null
      && (result.notices.vendorsEmailed > 0 || result.notices.vendorsFailed > 0 || result.notices.firstMarksInserted > 0);
    const fields = {
      outcome: "completed",
      follow_up: result.followUp,
      ledger: result.ledger,
      notices: result.notices,
      elapsed_ms: result.elapsedMs,
    };
    // A tick that changed nothing is the normal quiet case (CLAUDE.md §10): DEBUG.
    if (followUpActed || ledgerActed || noticesActed) this.deps.log.info("dropship.catalog_arrivals.tick", fields);
    else this.deps.log.debug("dropship.catalog_arrivals.tick", fields);
  }

  private elapsedSince(started: number): number {
    return Math.max(0, Math.round(this.deps.timer() - started));
  }
}

/** The ledger walk: every sellable size in keyset batches, the exposed ones in a category inserted. */
async function walkLedger(session: CatalogArrivalsLedgerSession, now: Date, baseline: boolean): Promise<number> {
  const exposureRules = await session.listCatalogExposureRules();
  let afterId = 0;
  let insertedCount = 0;
  for (;;) {
    const ids = await session.listSellableVariantIdsAfter(afterId, CATALOG_ARRIVALS_LEDGER_BATCH_SIZE);
    if (ids.length === 0) return insertedCount;
    if (ids.some((id, index) => id <= (index === 0 ? afterId : ids[index - 1]))) {
      throw invariantFailed("The arrivals ledger's catalog cursor did not advance.", { afterId });
    }
    const rows = ledgerArrivalsFromSubjects(await session.readArrivalSubjects(ids), exposureRules, now);
    if (rows.length > 0) insertedCount += await session.insertArrivals({ rows, baseline, now });
    afterId = ids[ids.length - 1];
  }
}

/** A notice mark as a log line names it (CLAUDE.md §10: before and after of a Got it). */
interface AcknowledgeLogMark {
  seen_through_arrival_id: number;
  notified_through_arrival_id: number;
}

function acknowledgeLogMark(seenThroughArrivalId: number, notifiedThroughArrivalId: number): AcknowledgeLogMark {
  return { seen_through_arrival_id: seenThroughArrivalId, notified_through_arrival_id: notifiedThroughArrivalId };
}

/** "New for V" from one snapshot's facts, grouped by category, against the asked watermark. */
function newItemsFromFacts(facts: CatalogNewForVendorFacts, watermark: "notified" | "seen", now: Date): CatalogNewItemsCategory[] {
  const fresh = freshArrivalsFromFacts(facts, watermark, now);
  return groupNewItems(fresh.arrivals, fresh.categoryNames);
}

/** The arrivals new for V from one snapshot's facts, against the asked watermark, with the categories' names. */
function freshArrivalsFromFacts(facts: CatalogNewForVendorFacts, watermark: "notified" | "seen", now: Date): {
  arrivals: CatalogArrivalFact[]; categoryNames: ReadonlyMap<number, string>;
} {
  const watermarks = new Map(facts.marks.map((mark) => [mark.categoryId,
    watermark === "notified" ? mark.notifiedThroughArrivalId : mark.seenThroughArrivalId]));
  const arrivals = decideNewForVendor({
    arrivals: facts.arrivals,
    watermarks,
    subjects: new Map(facts.subjects.map((subject) => [subject.productVariantId, subject])),
    exposureRules: facts.exposureRules,
    now,
  });
  return { arrivals, categoryNames: new Map(facts.categoryNames.map((row) => [row.categoryId, row.name])) };
}

/** Every mark a day's stored events name, at the highest arrival id named for it (each channel stores the same payload). */
function mergeNamedMarks(named: ReadonlyArray<ReadonlyArray<{ categoryId: number; throughArrivalId: number }>>): Array<{
  categoryId: number; throughArrivalId: number;
}> {
  const byCategory = new Map<number, number>();
  for (const marks of named) {
    for (const mark of marks) byCategory.set(mark.categoryId, Math.max(byCategory.get(mark.categoryId) ?? 0, mark.throughArrivalId));
  }
  return [...byCategory].sort(([left], [right]) => left - right)
    .map(([categoryId, throughArrivalId]) => ({ categoryId, throughArrivalId }));
}

/** Detail only on a line a human reads (ERROR): our contexts hold ids, counts and codes. */
function errorDetail(error: unknown, forHuman: boolean): Record<string, unknown> {
  if (!forHuman) return {};
  return {
    error_message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DropshipError && error.context ? { error_context: error.context } : {}),
  };
}

function parseServiceInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new DropshipError(CATALOG_ARRIVALS_ERROR_CODES.newItemsInvalidInput, "The new-items notice input failed validation.", {
    issues: parsed.error.issues.map((issue) => issue.path.join(".")), classification: "permanent", retryable: false,
  });
}

export type { CatalogArrivalFact, CatalogArrivalSubject, CatalogArrivalInsert, CatalogNoticeMark, CatalogNewItemsCategory };
