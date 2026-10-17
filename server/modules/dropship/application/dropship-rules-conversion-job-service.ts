import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { RULES_CONVERSION_PLANNER_VERSION, checkRulesConversion } from "./dropship-listing-rules-conversion";
import {
  RULES_CONVERSION_APPLIED_ACTION,
  convertInTransaction,
  rulesConversionAppliedLogFields,
  rulesConversionSystemKey,
  type ConversionSkipReason,
  type ListingRulesConversionRepository,
  type RulesConversionCostReadLog,
} from "./dropship-listing-rules-conversion-service";
import { conversionCostReadFailedError, type ListingSettingsConversionLoad } from "./dropship-listing-settings-service";
import type { DropshipClock } from "./dropship-ports";

/**
 * The rules conversion's system job (PR 11e2, plan 13, D1, D15, D20): every
 * hour, each eligible eBay store that still holds older group rules and was
 * never converted is checked; a clean one is moved over by the system in one
 * transaction (the 11c2 transaction, convertInTransaction's system mode); a
 * store that fails fatally is recorded once and left alone until its rules
 * or the planner change; one tick line names the stores still left.
 *
 * One tick:
 * 1. the clock, read once; the run's actor id from its UTC hour;
 * 2. the stores (the source's one pool query): eligible ones to check, and
 *    the counts and ids of those not eligible or dead-lettered, for the tick
 *    line (a failure to list them fails the tick: the runner logs it);
 * 3. per eligible store, in the source's order (vendor, then store): the dry
 *    run's load in its own read-only snapshot with no store lock (so a store
 *    that is not clean never holds up a listing queue, plan 13.8), the plan;
 *    only a clean one is applied, and the apply re-checks everything under
 *    the store lock and writes only if it is still clean (plan 7.B.3);
 * 4. one tick line: INFO whenever anything was converted or is left, and on
 *    the day's first quiet tick (UTC hour 0, so the latest INFO line is never
 *    more than about a day old, D15); DEBUG on any other quiet tick.
 *
 * A failing store never stops the others. Its error is classified (CLAUDE.md
 * §6): a store deleted since the list is expected (DEBUG); a transient one
 * (a cost read timeout, a busy or lost database, node-postgres' code-less
 * connection losses included, a catalog that moved under the locks) is
 * retried next tick (WARN `deferred`), never recorded; a fault of the shared
 * .ops cost source that a retry can't clear is retried next tick too, never
 * recorded (it is not the store's rules' or the planner's, so D20's skip
 * would not re-arm once the source is fixed), with one ERROR a tick naming
 * every store it stopped; anything else, fatal or an unexpected permanent
 * code, is recorded once as a
 * `listing_rules_conversion_failed` audit row naming the store's three head
 * revision ids and the planner version, logged ERROR once, and the source
 * leaves the store out until one of those changes (D20: never retried
 * blindly). Ids and counts only in every line, never a name or a text value
 * (plan 3.5).
 *
 * Pure orchestration: the reads and writes are the source's and the
 * repository's, the plan is the planner's, the clock is injected and read
 * once per tick. No money is computed here.
 */

/** The three head revisions a store's older rules are read from (null for a profile the store never saved). */
export interface RulesConversionHeadRevisions {
  pricing: number | null;
  content: number | null;
  ebayRules: number | null;
}

/** An eligible store with older rules and no conversion, with the head revisions the source read for it. */
export interface RulesConversionJobStore {
  vendorId: number;
  storeConnectionId: number;
  revisions: RulesConversionHeadRevisions;
}

/**
 * The source's one read (plan 13.2): eBay stores that hold older group rules
 * and have no conversion row, split three ways. `eligible` (store connected,
 * needing a sign-in or a token refresh, of an active or onboarding vendor
 * with an active .ops entitlement, and not dead-lettered) is checked; the
 * other two are only reported. Ids
 * ascending by vendor, then store; each store in exactly one list.
 */
export interface RulesConversionJobStores {
  eligible: RulesConversionJobStore[];
  notEligibleStoreIds: number[];
  /**
   * Eligible stores with a failure audit row (any of them) that names their
   * current head revisions and this planner version (D20); that is the latest
   * failure's inputs, as heads only move forward and the version only rises.
   */
  deadLetteredStoreIds: number[];
}

export interface RulesConversionJobSource {
  listStores(input: { plannerVersion: number }): Promise<RulesConversionJobStores>;
}

/** The dry run's load for one store whose owner is found by the store (the system has no member). */
export interface RulesConversionStoreLoad {
  vendorId: number;
  load: ListingSettingsConversionLoad;
}

/** The audit row's event type of a store the job dead-lettered (D20); the source's exclusion matches on it. */
export const RULES_CONVERSION_FAILED_EVENT = "listing_rules_conversion_failed";

const auditRevisionId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const rulesConversionHeadRevisionsSchema = z.object({
  pricing: auditRevisionId, content: auditRevisionId, ebayRules: auditRevisionId,
}).strict();

/**
 * The payload of a `listing_rules_conversion_failed` audit row (D20): what
 * failed, where, and the exact rules and planner it failed on. The source
 * skips the store while its current head revisions and the planner version
 * equal `revisions` and `plannerVersion`. Codes and ids only.
 */
export const rulesConversionFailureAuditSchema = z.object({
  plannerVersion: z.number().int().positive(),
  revisions: rulesConversionHeadRevisionsSchema,
  stage: z.enum(["check", "apply"]),
  errorCode: z.string().min(1).max(100),
  errorClass: z.enum(["permanent", "fatal"]),
  causeCode: z.string().min(1).max(100).nullable(),
  jobKey: z.string().min(1).max(255),
}).strict();
export type RulesConversionFailureAudit = z.infer<typeof rulesConversionFailureAuditSchema>;

/**
 * How recording a failure ended: written now, already written for these
 * revisions (a replay), not written because a rule revision moved since the
 * source read it (the store is checked again next tick with its new rules),
 * or not written because the store is gone.
 */
export type RulesConversionFailureRecordOutcome = "recorded" | "already_recorded" | "rules_changed" | "store_gone";

/** The repository the job uses: the 11c2 transaction, the dry run's load by store, and the failure record. */
export interface RulesConversionJobRepository extends Pick<ListingRulesConversionRepository, "executeConversion"> {
  /** The dry run's load (loadConversionInputsWithClient) in one read-only snapshot, the owner found by store; null when gone. */
  loadConversionInputsForStore(input: { storeConnectionId: number; now: Date }): Promise<RulesConversionStoreLoad | null>;
  /**
   * One short transaction: the store's current head revisions, compared with
   * the ones the failure was planned from, then one audit row (severity
   * `error`, actor `system`) unless an identical one exists.
   */
  recordFailure(input: {
    storeConnectionId: number;
    expectedVendorId: number;
    payload: RulesConversionFailureAudit;
    now: Date;
  }): Promise<RulesConversionFailureRecordOutcome>;
}

/** The job's lines through the platform logger: it needs DEBUG for its quiet ticks and its expected skips. */
export interface RulesConversionJobLog {
  debug(action: string, fields: Record<string, unknown>): void;
  info(action: string, fields: Record<string, unknown>): void;
  warn(action: string, fields: Record<string, unknown>): void;
  error(action: string, fields: Record<string, unknown>): void;
}

/**
 * Where the repository's cost-read reporter (rulesConversionCostReadReporter)
 * writes in the job: DEBUG only. The job's own line for the same failure
 * (WARN `deferred`, or the tick's one ERROR) carries the stage, the SQLSTATE
 * and the job key, so one event gets one line at its level (CLAUDE.md §10).
 * The vendor's apply keeps the reporter's WARN: its 503 line carries neither.
 */
export function rulesConversionJobCostReadLog(log: Pick<RulesConversionJobLog, "debug">): RulesConversionCostReadLog {
  return {
    warn: (action, fields) => log.debug(action, fields),
    debug: (action, fields) => log.debug(action, fields),
  };
}

export interface DropshipRulesConversionJobServiceDependencies {
  source: RulesConversionJobSource;
  repository: RulesConversionJobRepository;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; every write's time is `clock`, read once per tick. */
  timer: () => number;
  log: RulesConversionJobLog;
  /** What an ERROR line adds about the process (the scheduler's failure context: the error and both pools). */
  failureContext: (error: unknown) => Record<string, unknown>;
}

export interface RulesConversionTickResult {
  jobKey: string;
  plannerVersion: number;
  /** Eligible stores checked this tick. */
  storesChecked: number;
  converted: number;
  notClean: number;
  tooLarge: number;
  notEligible: number;
  /** Stores whose failure was fatal this tick (each logged ERROR once). */
  failed: number;
  /** Stores retried next tick: a transient failure, or a failure whose record could not be written. */
  deferred: number;
  /** Stores the .ops cost source failed for good this tick: never recorded, retried next tick, one ERROR for all. */
  costSourceFailed: number;
  deadLettered: number;
  alreadyConverted: number;
  /** Stores gone, no longer on eBay, no longer eligible or entitled under the lock, or with no older rules left. */
  skipped: number;
  elapsedMs: number;
}

export const RULES_CONVERSION_TICK_ACTION = "dropship.listing_settings.rules_conversion_tick";
export const RULES_CONVERSION_SKIPPED_ACTION = "dropship.listing_settings.rules_conversion_skipped";
export const RULES_CONVERSION_DEFERRED_ACTION = "dropship.listing_settings.rules_conversion_deferred";
export const RULES_CONVERSION_FAILED_ACTION = "dropship.listing_settings.rules_conversion_failed";

/**
 * The UTC hour whose tick logs its line at INFO even when nothing is left
 * (`stores_left: 0`), once a day: a quiet tick is otherwise DEBUG, which the
 * default level drops, so without it the latest INFO line would keep naming
 * a store the vendor has since moved by hand (D15; PR 12's evidence).
 */
export const DAILY_TICK_REPORT_UTC_HOUR = 0;

/** A log line names at most this many stores per outcome, with the full count beside them (plan 13.3, D15). */
export const MAX_LOGGED_STORES = 100;
const STORE_GONE = "DROPSHIP_STORE_CONNECTION_REQUIRED";
/** The code a failure line and its audit row carry when the error is not a DropshipError (CLAUDE.md §6, §10). */
const STORE_FAILED_CODE = "DROPSHIP_RULES_CONVERSION_STORE_FAILED";
/** The code a deferred line carries for a raw database fault a retry can clear (retryableDatabaseFailure). */
const DATABASE_BUSY_CODE = "DROPSHIP_RULES_CONVERSION_DATABASE_BUSY";
/**
 * node-postgres' own words when a connection ends with no error from the
 * server; such an error has no `code` (pg 8.20, lib/client.js: "Connection
 * terminated unexpectedly" for every pending query, "Client has encountered a
 * connection error and is not queryable" for any statement after it). The
 * finance reader matches the same words (financeCodeForDatabaseError).
 */
const CONNECTION_TERMINATED_MESSAGE = /Connection terminated/i;
const CLIENT_NOT_QUERYABLE_MESSAGE = /is not queryable/;
/**
 * SQLSTATEs a retry can clear: class 08 (a connection exception) and class 53
 * (the server short of a resource), a statement cancelled or timed out
 * (57014), a lock timeout (55P03), a serialization failure (40001) and a
 * deadlock (40P01): the cost read's own transient set
 * (conversionCostReadFailedError) and the connection class.
 */
const RETRYABLE_SQLSTATE_CLASSES: readonly string[] = ["08", "53"];
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["57014", "55P03", "40001", "40P01"]);
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
/** Node's socket errors on the database connection (the finance reader's set, financeCodeForDatabaseError). */
const CONNECTION_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
]);
/** The cause conversionCostReadFailedError gives a cost read a retry can't clear: the shared .ops source, not the store. */
const COST_SOURCE_UNAVAILABLE = "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE";
const JOB_KEY_PREFIX = "rules-conversion-job:";
/** `toISOString()` is always UTC; years 0-9999 print as four digits, so the hour is its first 13 characters. */
const UTC_HOUR_LENGTH = 13;
const UTC_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/**
 * The run's actor id, one per UTC hour, `rules-conversion-job:YYYY-MM-DDTHH`
 * (the first-mark job's pattern, category-marks-job.ts). It names the run in
 * every row and line as the system actor; it is not a key: the conversion's
 * key is the store's own `rules-conversion:<store>` (rulesConversionSystemKey),
 * one per store, ever. Its own prefix keeps the two apart in every query.
 */
export function rulesConversionJobKey(now: Date): string {
  const hour = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString().slice(0, UTC_HOUR_LENGTH) : null;
  if (hour === null || !UTC_HOUR_PATTERN.test(hour)) {
    throw listingSettingsInvariantFailed("The rules conversion job was given a time it cannot name an hour by.", {
      now: hour === null ? null : now.toISOString(),
    });
  }
  return `${JOB_KEY_PREFIX}${hour}`;
}

type ErrorClass = "transient" | "permanent" | "fatal";

/** What one store came to this tick. */
type StoreOutcome =
  | { kind: "converted" }
  | { kind: "not_clean"; changedSizeCount: number; wouldLosePriceCount: number; wouldBlockListingCount: number; tooMuchText: boolean }
  | { kind: "too_large" }
  | { kind: "already_converted" }
  | { kind: "skipped" }
  | { kind: "deferred" }
  | { kind: "cost_source_failed"; stage: "check" | "apply"; error: DropshipError }
  | { kind: "failed" };

type NotCleanStore = Extract<StoreOutcome, { kind: "not_clean" }> & { storeConnectionId: number };
/** A store the .ops cost source stopped this tick, with its vendor, for the tick's one ERROR line. */
type CostSourceFault = Extract<StoreOutcome, { kind: "cost_source_failed" }> & { vendorId: number };

export class DropshipRulesConversionJobService {
  constructor(private readonly deps: DropshipRulesConversionJobServiceDependencies) {}

  async runOnce(): Promise<RulesConversionTickResult> {
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const jobKey = rulesConversionJobKey(now);
    const plannerVersion = RULES_CONVERSION_PLANNER_VERSION;
    // A failure to list the stores fails the tick: the runner logs it, and the next tick runs in an hour.
    const stores = await this.deps.source.listStores({ plannerVersion });

    const byKind = new Map<StoreOutcome["kind"], number[]>();
    const notCleanStores: NotCleanStore[] = [];
    const costSourceFaults: CostSourceFault[] = [];
    for (const store of stores.eligible) {
      const outcome = await this.runStore(store, jobKey, now);
      const storeIds = byKind.get(outcome.kind);
      if (storeIds) storeIds.push(store.storeConnectionId);
      else byKind.set(outcome.kind, [store.storeConnectionId]);
      if (outcome.kind === "not_clean") notCleanStores.push({ ...outcome, storeConnectionId: store.storeConnectionId });
      if (outcome.kind === "cost_source_failed") costSourceFaults.push({ ...outcome, vendorId: store.vendorId });
    }
    const ids = (kind: StoreOutcome["kind"]) => byKind.get(kind) ?? [];
    const capped = (storeIds: readonly number[]) => storeIds.slice(0, MAX_LOGGED_STORES);
    if (costSourceFaults.length > 0) this.costSourceFailed(jobKey, costSourceFaults, ids("cost_source_failed"), capped);

    const result: RulesConversionTickResult = {
      jobKey,
      plannerVersion,
      storesChecked: stores.eligible.length,
      converted: ids("converted").length,
      notClean: ids("not_clean").length,
      tooLarge: ids("too_large").length,
      notEligible: stores.notEligibleStoreIds.length,
      failed: ids("failed").length,
      deferred: ids("deferred").length,
      costSourceFailed: ids("cost_source_failed").length,
      deadLettered: stores.deadLetteredStoreIds.length,
      alreadyConverted: ids("already_converted").length,
      skipped: ids("skipped").length,
      elapsedMs: Math.max(0, Math.round(this.deps.timer() - started)),
    };
    // Every store still holding older rules after this tick, each in one outcome: PR 12's evidence (D15).
    const left = result.notClean + result.tooLarge + result.notEligible + result.failed + result.deferred + result.costSourceFailed
      + result.deadLettered;
    const fields = {
      outcome: result.failed > 0 || result.deferred > 0 || result.costSourceFailed > 0 ? "partial" : "completed",
      job_key: jobKey,
      planner_version: plannerVersion,
      stores_checked: result.storesChecked,
      stores_left: left,
      converted_count: result.converted, converted_store_ids: capped(ids("converted")),
      not_clean_count: result.notClean,
      not_clean_stores: notCleanStores.slice(0, MAX_LOGGED_STORES).map((store) => ({
        store_connection_id: store.storeConnectionId, changed_size_count: store.changedSizeCount,
        would_lose_price_count: store.wouldLosePriceCount, would_block_listing_count: store.wouldBlockListingCount,
        too_much_text: store.tooMuchText,
      })),
      too_large_count: result.tooLarge, too_large_store_ids: capped(ids("too_large")),
      not_eligible_count: result.notEligible, not_eligible_store_ids: capped(stores.notEligibleStoreIds),
      failed_count: result.failed, failed_store_ids: capped(ids("failed")),
      deferred_count: result.deferred, deferred_store_ids: capped(ids("deferred")),
      cost_source_failed_count: result.costSourceFailed, cost_source_failed_store_ids: capped(ids("cost_source_failed")),
      dead_lettered_count: result.deadLettered, dead_lettered_store_ids: capped(stores.deadLetteredStoreIds),
      already_converted_count: result.alreadyConverted,
      skipped_count: result.skipped,
      elapsed_ms: result.elapsedMs,
    };
    // A state report, at most 24 a day (D15): INFO while anything moved or is left, and once a day when nothing is (so the
    // latest INFO line is never a stale list); any other quiet tick is DEBUG (CLAUDE.md §10). The hour is the tick's one reading.
    if (result.converted > 0 || left > 0 || now.getUTCHours() === DAILY_TICK_REPORT_UTC_HOUR) {
      this.deps.log.info(RULES_CONVERSION_TICK_ACTION, fields);
    } else {
      this.deps.log.debug(RULES_CONVERSION_TICK_ACTION, fields);
    }
    return result;
  }

  /**
   * The tick's one ERROR for the stores the .ops cost source failed for good
   * (a missing table or column, a refused read): a human must fix the
   * source, and every store it stopped is named, with its vendor (a query by
   * vendor id finds the line, CLAUDE.md §10), the first failure's stage and
   * SQLSTATE, and every distinct cause (job stage, cost read stage, SQLSTATE)
   * of the tick, so a second fault behind the first is seen in the same
   * hour; each list holds at most MAX_LOGGED_STORES, with its full count
   * beside it. Nothing is recorded, so the next tick checks them all again by
   * itself once the source answers; the line repeats once a tick only while
   * the fault lasts.
   */
  private costSourceFailed(jobKey: string, faults: readonly CostSourceFault[], storeIds: readonly number[],
    capped: (storeIds: readonly number[]) => number[]): void {
    const { error, stage } = faults[0];
    const first = costReadCause(error);
    // Distinct, in the stores' order (the source's: vendor, then store).
    const vendorIds = [...new Set(faults.map((fault) => fault.vendorId))];
    const causes = new Map<string, { stage: "check" | "apply"; cost_read_stage: string | null; sql_state: string | null }>();
    for (const fault of faults) {
      const cause = { stage: fault.stage, ...costReadCause(fault.error) };
      const key = JSON.stringify([cause.stage, cause.cost_read_stage, cause.sql_state]);
      if (!causes.has(key)) causes.set(key, cause);
    }
    this.deps.log.error(RULES_CONVERSION_FAILED_ACTION, {
      job_key: jobKey, outcome: "deferred", reason: "cost_source_unavailable", stage, error_code: error.code, error_class: "fatal",
      cause_code: COST_SOURCE_UNAVAILABLE,
      ...(first.cost_read_stage === null ? {} : { cost_read_stage: first.cost_read_stage }),
      ...(first.sql_state === null ? {} : { sql_state: first.sql_state }),
      store_count: storeIds.length, store_connection_ids: capped(storeIds),
      vendor_count: vendorIds.length, vendor_ids: vendorIds.slice(0, MAX_LOGGED_STORES),
      cause_count: causes.size, causes: [...causes.values()].slice(0, MAX_LOGGED_STORES),
      dead_lettered: false,
      ...errorDetail(error), context: this.deps.failureContext(error),
    });
  }

  /**
   * One store: the check in its own read-only snapshot, then (clean only)
   * the system's transaction. Every failure ends here as an outcome, so the
   * next store always runs.
   */
  private async runStore(store: RulesConversionJobStore, jobKey: string, now: Date): Promise<StoreOutcome> {
    const { vendorId, storeConnectionId } = store;
    const line = { job_key: jobKey, vendor_id: vendorId, store_connection_id: storeConnectionId };
    let stage: "check" | "apply" = "check";
    try {
      // 3a. The dry run's load and plan, outside any lock.
      const checked = await this.deps.repository.loadConversionInputsForStore({ storeConnectionId, now });
      if (checked === null) return this.skipped(line, "store_not_found");
      if (checked.vendorId !== vendorId) {
        throw listingSettingsInvariantFailed("A store the rules conversion job checked has another vendor than its list said.", {
          storeConnectionId,
        });
      }
      const { load } = checked;
      if (load.state === "not_ebay") return this.skipped(line, "not_ebay");
      if (load.state === "too_large") return { kind: "too_large" };
      // Prices from cost can't be compared: transient (retried next tick) or fatal, by the check's own rule.
      if (load.costReadFailure !== null) throw conversionCostReadFailedError(storeConnectionId, load.costReadFailure);
      const { diff } = checkRulesConversion(load.inputs);
      if (diff.state === "no_older_rules") return this.skipped(line, "nothing_to_convert");
      if (diff.state !== "clean") {
        return {
          kind: "not_clean", changedSizeCount: diff.rows.length, wouldLosePriceCount: diff.blocked.wouldLosePrice.length,
          wouldBlockListingCount: diff.blocked.wouldBlockListing.length, tooMuchText: diff.blocked.tooMuchText,
        };
      }

      // 3b. Clean: the system's transaction, which re-checks everything under the store lock and writes only a clean store.
      stage = "apply";
      const started = this.deps.timer();
      const { result, transactionVendorId } = await this.deps.repository.executeConversion(
        { actorType: "system", jobKey, storeConnectionId },
        async (tx) => ({ result: await convertInTransaction(tx, { kind: "system" }, now), transactionVendorId: tx.vendorId }));
      switch (result.outcome) {
        case "converted":
          // The same success line as the vendor's (one query on its action returns every conversion), after COMMIT.
          this.deps.log.info(RULES_CONVERSION_APPLIED_ACTION, rulesConversionAppliedLogFields({
            result, vendorId: transactionVendorId, storeConnectionId, actor: { actorType: "system", actorId: jobKey },
            requestKey: rulesConversionSystemKey(storeConnectionId), elapsedMs: Math.max(0, Math.round(this.deps.timer() - started)),
          }));
          return { kind: "converted" };
        case "not_clean":
          return { kind: "not_clean", changedSizeCount: result.changedSizeCount, wouldLosePriceCount: result.wouldLosePriceCount,
            wouldBlockListingCount: result.wouldBlockListingCount, tooMuchText: result.tooMuchText };
        case "too_large":
          return { kind: "too_large" };
        case "already_converted":
          this.deps.log.debug(RULES_CONVERSION_SKIPPED_ACTION, { ...line, outcome: "already_converted" });
          return { kind: "already_converted" };
        case "nothing_to_convert":
          return this.skipped(line, "nothing_to_convert");
        case "skipped":
          return this.skipped(line, result.reason);
        default:
          throw listingSettingsInvariantFailed("The rules conversion job's transaction answered a vendor's outcome.", {
            storeConnectionId, outcome: result.outcome,
          });
      }
    } catch (error) {
      return this.failed(store, line, stage, error, jobKey, now);
    }
  }

  /** An expected skip (plan 13.7): DEBUG, never retried as a fault; the store's next tick decides again. */
  private skipped(line: Record<string, unknown>, reason: ConversionSkipReason | "nothing_to_convert"): StoreOutcome {
    this.deps.log.debug(RULES_CONVERSION_SKIPPED_ACTION, { ...line, outcome: "skipped", reason });
    return { kind: "skipped" };
  }

  /**
   * A store's failure, by its class (plan 13.7, CLAUDE.md §6, classify): a
   * store deleted since the list → DEBUG skip; transient (a DropshipError's
   * own class, or a raw database fault a retry can clear) → WARN `deferred`,
   * never recorded, next tick; anything else → one failure audit row in its
   * own short transaction, then one ERROR line, and the source leaves the store out
   * until its rules or the planner change (D20). A failure audit row that
   * cannot be written leaves the store to the next tick: WARN `deferred` when
   * that write's own failure is transient, else ERROR (the store can't be
   * dead-lettered, which needs a human).
   */
  private async failed(store: RulesConversionJobStore, line: Record<string, unknown>, stage: "check" | "apply", error: unknown,
    jobKey: string, now: Date): Promise<StoreOutcome> {
    const { code, errorClass, failure } = classify(error);
    const causeCode = causeCodeOf(error);
    if (code === STORE_GONE) {
      this.deps.log.debug(RULES_CONVERSION_SKIPPED_ACTION, { ...line, outcome: "skipped", reason: "store_not_found", stage });
      return { kind: "skipped" };
    }
    // Never recorded: a retry can clear it, so the store is checked again next tick (plan 13.7, CLAUDE.md §6).
    if (errorClass === "transient") {
      this.deps.log.warn(RULES_CONVERSION_DEFERRED_ACTION, { ...line, outcome: "deferred", stage, error_code: code,
        error_class: errorClass, ...(causeCode === null ? {} : { cause_code: causeCode }), ...(failure === null ? {} : { failure }),
        ...transientDetail(error) });
      return { kind: "deferred" };
    }
    // The shared cost source, not this store's rules: never dead-lettered on them (the tick's one ERROR names it, runOnce).
    if (error instanceof DropshipError && causeCode === COST_SOURCE_UNAVAILABLE) return { kind: "cost_source_failed", stage, error };

    const payload: RulesConversionFailureAudit = {
      plannerVersion: RULES_CONVERSION_PLANNER_VERSION, revisions: { ...store.revisions }, stage, errorCode: code,
      errorClass, causeCode, jobKey,
    };
    let recorded: RulesConversionFailureRecordOutcome;
    try {
      recorded = await this.deps.repository.recordFailure({
        storeConnectionId: store.storeConnectionId, expectedVendorId: store.vendorId, payload, now,
      });
    } catch (recordError) {
      const { code: recordCode, errorClass: recordClass, failure: recordFailure } = classify(recordError);
      const entry = { ...line, stage, error_code: code, error_class: errorClass, record_error_code: recordCode,
        record_error_class: recordClass, ...(recordFailure === null ? {} : { record_failure: recordFailure }), dead_lettered: false };
      if (recordClass === "transient") {
        this.deps.log.warn(RULES_CONVERSION_DEFERRED_ACTION, { ...entry, outcome: "deferred" });
        return { kind: "deferred" };
      }
      this.deps.log.error(RULES_CONVERSION_FAILED_ACTION, { ...entry, outcome: "failed", ...errorDetail(error),
        record_error_message: recordError instanceof Error ? recordError.message : String(recordError),
        context: this.deps.failureContext(error) });
      return { kind: "failed" };
    }
    // One ERROR per failure the job dead-letters; later ticks only count the store (dead_lettered_count).
    this.deps.log.error(RULES_CONVERSION_FAILED_ACTION, {
      ...line, outcome: "failed", stage, error_code: code, error_class: errorClass,
      ...(causeCode === null ? {} : { cause_code: causeCode }),
      planner_version: payload.plannerVersion, revisions: payload.revisions, record_outcome: recorded,
      dead_lettered: recorded === "recorded" || recorded === "already_recorded",
      ...errorDetail(error), context: this.deps.failureContext(error),
    });
    return { kind: "failed" };
  }
}

/** A DropshipError's own class (CLAUDE.md §6); one without a known class is treated as fatal. */
function classificationOf(error: DropshipError): ErrorClass {
  const value = error.context?.classification;
  return value === "transient" || value === "permanent" || value === "fatal" ? value : "fatal";
}

/**
 * Any failure as the job's code, class and (for a raw database fault a
 * retry can clear) the failure a deferred line names: a DropshipError keeps
 * its own; a raw error is transient when retryableDatabaseFailure names it,
 * else fatal (recorded once, D20).
 */
function classify(error: unknown): { code: string; errorClass: ErrorClass; failure: string | null } {
  if (error instanceof DropshipError) return { code: error.code, errorClass: classificationOf(error), failure: null };
  const failure = retryableDatabaseFailure(error);
  return failure === null
    ? { code: STORE_FAILED_CODE, errorClass: "fatal", failure: null }
    : { code: DATABASE_BUSY_CODE, errorClass: "transient", failure };
}

/**
 * The name of a raw database fault a retry can clear, else null (plan 13.7's
 * "lock or connection busy, deadlock" row; plan 3.4's "connection loss"): a
 * retryable SQLSTATE or socket error as itself, node-postgres' code-less
 * connection losses as `connection_terminated` or `client_not_queryable`. A
 * coded error is judged by its code alone. The check, the apply
 * and the record each map their failures through the listing-settings mapper
 * (mapListingSettingWriteError), which hands these back raw and stays as it
 * is, so PR 9's routes keep their statuses; the job, which runs unattended,
 * classifies them here so that one lost connection never dead-letters a clean
 * store (D20's record is for faults a retry can't clear). Only raw errors: a
 * DropshipError's own class stands.
 */
function retryableDatabaseFailure(error: unknown): string | null {
  if (error instanceof DropshipError || error === null || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") {
    const retryable = CONNECTION_ERRNOS.has(code) || (SQLSTATE_PATTERN.test(code)
      && (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_SQLSTATE_CLASSES.some((sqlClass) => code.startsWith(sqlClass))));
    return retryable ? code : null;
  }
  if (typeof message !== "string") return null;
  if (CONNECTION_TERMINATED_MESSAGE.test(message)) return "connection_terminated";
  if (CLIENT_NOT_QUERYABLE_MESSAGE.test(message)) return "client_not_queryable";
  return null;
}

/**
 * The cause a line and the audit row name: a DropshipError's `causeCode`
 * (the writer's code under D24, the cost source's), else its `sqlState`
 * (a CHECK or guard, a deadlock, a cost read timeout), else the code
 * node-postgres (a SQLSTATE) or Node (an errno) put on a raw error; null
 * when there is none.
 */
function causeCodeOf(error: unknown): string | null {
  const code = error instanceof DropshipError
    ? error.context?.causeCode ?? error.context?.sqlState
    : error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 && code.length <= 100 ? code : null;
}

/** A cost-source fault's cause as the ERROR line names it: the cost read's stage and SQLSTATE, null when the error has none. */
function costReadCause(error: DropshipError): { cost_read_stage: string | null; sql_state: string | null } {
  const { stage, sqlState } = error.context ?? {};
  return { cost_read_stage: typeof stage === "string" ? stage : null, sql_state: typeof sqlState === "string" ? sqlState : null };
}

/** A transient failure's retry detail: the busy reason or failure, the cost read's stage (codes only). */
function transientDetail(error: unknown): Record<string, unknown> {
  if (!(error instanceof DropshipError) || !error.context) return {};
  const { reason, failure, stage } = error.context;
  return Object.fromEntries(Object.entries({ reason, failure, cost_read_stage: stage })
    .filter(([, value]) => typeof value === "string"));
}

/** Only a line a human reads carries the error's words and context; our contexts hold ids, counts and codes, never vendor text. */
function errorDetail(error: unknown): Record<string, unknown> {
  return {
    error_message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DropshipError && error.context ? { error_context: error.context } : {}),
  };
}
