import { createHash } from "node:crypto";
import {
  CATALOG_ARRIVALS_ERROR_CODES,
  CATALOG_JOB_FAILURE_ALERT_STREAK,
  classifyCatalogJobError,
  describeSelectionRulesConvertedNotice,
  invariantFailed,
  selectionRulesConvertedIdempotencyKey,
} from "../domain/catalog-arrivals";
import type { DropshipCatalogExposureSubject } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX } from "../domain/selection-release";
import { vendorRulesPick, type DropshipVendorSelectionRule } from "../domain/vendor-selection";
import { isCatalogAccessBlockedVendorStatus } from "../domain/vendor-standing";
import type { CatalogJobLog } from "./dropship-catalog-arrivals-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import {
  retryableSaveFailureCode,
  SELECTION_CHANGE_PLAN_MOVED,
  SELECTION_SAVE_ATTEMPTS,
  selectionSaveRetryDelayMs,
} from "./dropship-selection-change-service";

/**
 * The conversion follow-up (step 1 plan S2-5, PR B; PLAN-B v4.1 §11.2): the
 * first B process finishes what the release-time conversion started, once
 * per converted vendor, inside the arrivals job's tick
 * (dropship-catalog-arrivals-service.ts):
 *
 * - Repair (FIDELITY-1): only where the TypeScript matcher of the frozen
 *   rules (`vendorRulesPick`, VS) and the conversion's SQL twin
 *   (`SELECTION_RULE_MATCH_SQL`, read as a column of the same catalog row)
 *   disagree: TS true, SQL false and no pick → insert (`conversion_repair`);
 *   TS false, SQL true and a `legacy_*` pick → delete. Only HYPOTHESIS A10
 *   (PostgreSQL `lower()` ≠ JavaScript `toLowerCase()`) can produce one, and
 *   it would disagree the same way on a size created or moved since. So only
 *   a size whose matcher inputs are still the ones the conversion read for it
 *   is repaired (`asConverted`, the conversion's record of sizes; FUP-1): a
 *   size created since, or whose product, category or product lines changed,
 *   keeps its pick as the conversion wrote it, and nothing is added or removed
 *   without a vendor's save (decision 3). Skipped once the vendor saved (its
 *   head revision is no longer the backfill revision): that save stands.
 * - Tidy: the vendor's `legacy_broad_rule` picks of sizes Card Shellz does
 *   not offer now and that have no listing row on any of its stores. Stock
 *   neutral: such a size is selected neither before nor after, and no
 *   listing carries a duty.
 * - In one transaction per vendor, under the vendor's selection lock and the
 *   conversion row's lock, every candidate re-checked on fresh reads: the
 *   writes (a `picks_conversion_followup` revision and the gated picks
 *   writes, only when something changes), the audit row and `done`. A rerun
 *   after `done` writes nothing (CLAUDE.md §7).
 * - Then, after commit, the one conversion notice (a deliberate side
 *   channel, CLAUDE.md §6), and `notice_state = 'sent'`. A vendor that may not
 *   open the catalog (closed, lapsed, suspended; the list step 1's own access
 *   check refuses, JOB-1) is not told yet: its notice stays pending and goes
 *   out on the first tick after it may open the catalog again.
 *
 * Not behind the picks writes gate (§10): a repair makes the picks equal to
 * what the frozen rules give on the same rows, and a tidy removes only sizes
 * no reader selects.
 *
 * Error classes per vendor (CLAUDE.md §6; FIDELITY-4, SAFETY-3); one vendor's
 * failure never blocks another: busy (a held publication gate, a lock
 * timeout, a deadlock, a serialization failure or a plan that moved, after
 * this tick's retries, or a lost connection) → stays pending, DEBUG, no
 * streak; transient → `followup_failures + 1`, WARN, one ERROR
 * DROPSHIP_SELECTION_CONVERSION_FOLLOWUP_FAILED when the streak reaches 3;
 * permanent (a refusal, an integrity violation) → `requires_review` with the
 * code, one ERROR, never read again; any other failure (a fault) → ERROR and
 * the streak, retried next tick. A failure to read the conversions
 * themselves aborts the stage and the tick classifies it.
 */

/** Catalog rows the repair walk reads at a time. */
export const FOLLOW_UP_REPAIR_BATCH_SIZE = 1_000;
/** Broad picks the tidy walk, and every re-check, reads at a time. */
export const FOLLOW_UP_TIDY_BATCH_SIZE = 500;
/** A log line names at most this many ids, with the full count beside it. */
const MAX_LOGGED_IDS = 100;
const NOTIFICATION_IDEMPOTENCY_CONFLICT = "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT";
const LEGACY_PICK_SOURCES: ReadonlySet<string> = new Set(["legacy_variant_rule", "legacy_broad_rule"]);

/** A row of `dropship.dropship_selection_conversions` the stage reads. */
export interface SelectionConversionRecord {
  vendorId: number;
  backfillRevisionId: number;
  followupState: "pending" | "done" | "requires_review";
  noticeState: "not_needed" | "pending" | "sent" | "requires_review";
  followupFailures: number;
}

/** An open conversion as the stage lists it: the row and its vendor's status (the notice waits while step 1 refuses it). */
export interface OpenSelectionConversion extends SelectionConversionRecord {
  vendorStatus: string;
}

/**
 * One Card Shellz size as the repair reads it: the matcher's inputs, the
 * vendor's pick (its source, or null), whether those inputs are the ones the
 * conversion read for the size, and the SQL twin's answer for the vendor's
 * active rules, all from the same row.
 */
export interface FollowUpCatalogRow extends DropshipCatalogExposureSubject {
  pickSource: string | null;
  /** The size is in the conversion's record of sizes, with the same product, text category and product lines (FUP-1). */
  asConverted: boolean;
  sqlRulesPick: boolean;
}

/** The read-only detection reads (no transaction, no lock). */
export interface FollowUpDetectionReads {
  /** Every `catalog.product_variants` row joined to its product after `afterId`, ascending, sellable or not. */
  listRepairRowsAfter(input: { vendorId: number; afterId: number; limit: number }): Promise<FollowUpCatalogRow[]>;
  /** The vendor's `legacy_broad_rule` picks after `afterId`, ascending. */
  listBroadPickIdsAfter(input: { vendorId: number; afterId: number; limit: number }): Promise<number[]>;
  /** Which of these sizes Card Shellz offers the vendor now (SEL offeredVariantIdsAmong: sellable, exposed, not turned off). */
  readOfferedAmong(input: { vendorId: number; productVariantIds: readonly number[]; now: Date }): Promise<Set<number>>;
  /** Which of these sizes have a `dropship_vendor_listings` row of the vendor, on any store. */
  readListedAmong(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<Set<number>>;
}

/** One vendor's apply transaction; the repository has begun it and taken the vendor's selection lock. */
export interface FollowUpApplyTransaction {
  /** The conversion row, `FOR UPDATE`; null when there is none. */
  lockConversion(vendorId: number): Promise<SelectionConversionRecord | null>;
  readHeadRevisionId(vendorId: number): Promise<number | null>;
  /** The repair columns of these sizes, read again. */
  readRepairRows(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<FollowUpCatalogRow[]>;
  /** Which of these sizes are still `legacy_broad_rule` picks of the vendor. */
  readBroadPickIds(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<Set<number>>;
  readOfferedAmong(input: { vendorId: number; productVariantIds: readonly number[]; now: Date }): Promise<Set<number>>;
  readListedAmong(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<Set<number>>;
  /** The vendor's pick rows outside these sizes, in one statement (the save's split, SRV-1). */
  countPicksOutside(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<number>;
  /** A `picks_conversion_followup` revision (system actor, `rule_count 0`). Returns its id. */
  insertRevision(input: {
    vendorId: number; idempotencyKey: string; requestHash: string; pickCount: number; result: Record<string, unknown>; now: Date;
  }): Promise<number>;
  /** The `vendor_selection_conversion_followed_up` audit row. */
  insertAudit(input: { vendorId: number; revisionId: number; payload: Record<string, unknown>; now: Date }): Promise<void>;
  /** `FOR KEY SHARE` on the sizes to insert, ascending: the ids that still exist. */
  preLockVariants(productVariantIds: readonly number[]): Promise<number[]>;
  /** Gated. Returns the rows deleted. */
  deletePicks(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<number>;
  /** Gated. `source 'conversion_repair'`, ON CONFLICT DO NOTHING. Returns the rows inserted. */
  insertRepairPicks(input: { vendorId: number; revisionId: number; productVariantIds: readonly number[]; now: Date }): Promise<number>;
  /** `followup_state 'done'`, `followup_at`, the streak reset; refuses (fatal) unless the row was pending. */
  markFollowUpDone(input: { vendorId: number; now: Date }): Promise<void>;
}

export interface DropshipSelectionConversionFollowUpRepository {
  /** Rows with a pending follow-up, or a done follow-up and a pending notice (the partial index); never `requires_review`. */
  listOpenConversions(): Promise<OpenSelectionConversion[]>;
  /** The vendor's active frozen rules (the follow-up is the only runtime reader besides the frozen GET, V5). */
  readFrozenRules(vendorId: number): Promise<DropshipVendorSelectionRule[]>;
  detectionReads(): FollowUpDetectionReads;
  /** BEGIN, a short lock timeout, the vendor's selection lock, `work`, COMMIT; ROLLBACK and rethrow on any error. */
  runApply<T>(input: { vendorId: number }, work: (tx: FollowUpApplyTransaction) => Promise<T>): Promise<T>;
  /** The vendor's selected count now (SEL's count, picked and offered), in one read-only snapshot. */
  readSelectedCount(input: { vendorId: number; now: Date }): Promise<number>;
  /** `notice_state 'sent'`, `notice_at`, the streak reset, where the notice was pending. */
  markNoticeSent(input: { vendorId: number; now: Date }): Promise<void>;
  /** `followup_failures + 1` on an open row; returns the new streak, or null when the row is no longer open. */
  recordFailure(input: { vendorId: number }): Promise<number | null>;
  /** The stage's state → `requires_review` with the code, where it was pending. */
  markRequiresReview(input: { vendorId: number; stage: "followup" | "notice"; errorCode: string }): Promise<void>;
}

/** The notification service's call the notice makes (dropship-notification-service.ts). */
export interface ConversionNoticeSender {
  send(input: {
    vendorId: number; eventType: string; critical: boolean; title: string; message: string;
    payload: Record<string, unknown>; idempotencyKey: string;
  }): Promise<{ events: readonly unknown[]; idempotentReplay: boolean }>;
}

export interface DropshipSelectionConversionFollowUpDependencies {
  repository: DropshipSelectionConversionFollowUpRepository;
  notifications: ConversionNoticeSender;
  log: CatalogJobLog;
  /** Waits between attempts; injected so a test never sleeps. */
  sleep(delayMs: number): Promise<void>;
  /** A seeded source in [0, 1) for the retry jitter (seededJitterSource). */
  random(): number;
}

export interface ConversionFollowUpStageResult {
  conversionsRead: number;
  followUpsDone: number;
  /** Follow-ups left pending this tick because the database stayed busy (no streak). */
  followUpsBusy: number;
  noticesSent: number;
  /** Notices left pending because the vendor may not open the catalog now (JOB-1). */
  noticesDeferred: number;
  vendorsFailed: number;
  requiresReview: number;
}

/** What the detection found, before the apply re-checks it under the locks. */
export interface FollowUpCandidates {
  repairInsertIds: number[];
  repairDeleteIds: number[];
  tidyIds: number[];
}

type ApplyOutcome =
  | { kind: "done"; revisionId: number | null; repairAllowed: boolean; insertedIds: number[]; repairDeletedIds: number[]; tidiedIds: number[] }
  | { kind: "not_pending"; followupState: SelectionConversionRecord["followupState"] | null };

type FollowUpOutcome = ApplyOutcome | { kind: "busy" };

/**
 * The repair a row asks for (FIDELITY-1): only when the TypeScript matcher
 * and the SQL twin disagree on this very row, and only on a size whose
 * matcher inputs are still what the conversion decided from (FUP-1). Never
 * compared with the pick alone. A size created since, or moved to another
 * product, category or product line set, is never touched, even where the
 * two matchers disagree on it: the conversion never decided it.
 */
export function followUpRepairAction(
  rules: readonly DropshipVendorSelectionRule[],
  row: FollowUpCatalogRow,
): "insert" | "delete" | null {
  if (!row.asConverted) return null;
  const tsPick = vendorRulesPick(rules, row);
  if (tsPick === row.sqlRulesPick) return null;
  if (tsPick && row.pickSource === null) return "insert";
  if (!tsPick && row.pickSource !== null && LEGACY_PICK_SOURCES.has(row.pickSource)) return "delete";
  return null;
}

/** The follow-up revision's key (V8, SAFETY-6): the reserved prefix, the vendor and its backfill revision. */
export function conversionFollowUpIdempotencyKey(vendorId: number, backfillRevisionId: number): string {
  return `${LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX}followup:${vendorId}:${backfillRevisionId}`;
}

export class DropshipSelectionConversionFollowUp {
  constructor(private readonly deps: DropshipSelectionConversionFollowUpDependencies) {}

  /** The stage (§11.2): every open conversion, one vendor at a time. */
  async runStage(now: Date): Promise<ConversionFollowUpStageResult> {
    // Outside any vendor's work: a failure here aborts the stage, and the tick classifies it.
    const records = await this.deps.repository.listOpenConversions();
    const result: ConversionFollowUpStageResult = {
      conversionsRead: records.length, followUpsDone: 0, followUpsBusy: 0, noticesSent: 0, noticesDeferred: 0, vendorsFailed: 0,
      requiresReview: 0,
    };
    for (const record of records) {
      let stage: "followup" | "notice" = "followup";
      try {
        let followUpDone = record.followupState === "done";
        if (record.followupState === "pending") {
          const outcome = await this.followUpVendor(record, now);
          if (outcome.kind === "busy") {
            result.followUpsBusy += 1;
            continue;
          }
          if (outcome.kind === "done") result.followUpsDone += 1;
          followUpDone = outcome.kind === "done" || outcome.followupState === "done";
        }
        // d. Only after the follow-up is done (SAFETY-6): a done row with a pending notice runs this alone.
        if (followUpDone && record.noticeState === "pending") {
          if (isCatalogAccessBlockedVendorStatus(record.vendorStatus)) {
            // Not a failure and not a transition: read again each tick until step 1 lets the vendor in (DEBUG).
            result.noticesDeferred += 1;
            this.deps.log.debug("dropship.selection.conversion_notice_deferred", {
              outcome: "deferred", vendor_id: record.vendorId, vendor_status: record.vendorStatus,
              backfill_revision_id: record.backfillRevisionId,
            });
            continue;
          }
          stage = "notice";
          await this.sendNotice(record, now);
          result.noticesSent += 1;
        }
      } catch (error) {
        result.vendorsFailed += 1;
        if (await this.handleVendorFailure(record, stage, error)) result.requiresReview += 1;
      }
    }
    return result;
  }

  /** a-c for one vendor: detect without locks, then apply under them, retried like the save. */
  private async followUpVendor(record: SelectionConversionRecord, now: Date): Promise<FollowUpOutcome> {
    const rules = await this.deps.repository.readFrozenRules(record.vendorId);
    const candidates = await this.detect(record.vendorId, rules, now);
    const attemptCodes: string[] = [];
    for (let attempt = 1; attempt <= SELECTION_SAVE_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.deps.repository.runApply({ vendorId: record.vendorId },
          (tx) => applyFollowUp(tx, { record, rules, candidates, now }));
        if (outcome.kind === "done") this.logDone(record, outcome);
        return outcome;
      } catch (error) {
        const retryCode = retryableSaveFailureCode(error);
        if (retryCode === null) throw error;
        attemptCodes.push(retryCode);
        if (attempt === SELECTION_SAVE_ATTEMPTS) break;
        const delayMs = selectionSaveRetryDelayMs(attempt, this.deps.random);
        this.deps.log.debug("dropship.selection.conversion_followup_retry", {
          outcome: "retrying", vendor_id: record.vendorId, attempt, delay_ms: delayMs, error_code: retryCode, error_class: "transient",
        });
        await this.deps.sleep(delayMs);
      }
    }
    // Busy through every attempt: expected under load, retried next tick, not a failure streak (§11.2).
    this.deps.log.debug("dropship.selection.conversion_followup_deferred", {
      outcome: "deferred", vendor_id: record.vendorId, attempts: SELECTION_SAVE_ATTEMPTS, attempt_error_codes: attemptCodes,
      error_code: attemptCodes[attemptCodes.length - 1] ?? null, error_class: "transient",
    });
    return { kind: "busy" };
  }

  /** The read-only detection: the repair walk over every catalog size, then the tidy walk over the broad picks. */
  private async detect(vendorId: number, rules: readonly DropshipVendorSelectionRule[], now: Date): Promise<FollowUpCandidates> {
    const reads = this.deps.repository.detectionReads();
    const candidates: FollowUpCandidates = { repairInsertIds: [], repairDeleteIds: [], tidyIds: [] };
    // Repair: every size, not only picks (SAFETY-1), so an unpicked size the TS matcher accepts is visited.
    let afterId = 0;
    for (;;) {
      const rows = await reads.listRepairRowsAfter({ vendorId, afterId, limit: FOLLOW_UP_REPAIR_BATCH_SIZE });
      if (rows.length === 0) break;
      assertAscending(rows.map((row) => row.productVariantId), afterId, "repair");
      for (const row of rows) {
        const action = followUpRepairAction(rules, row);
        if (action === "insert") candidates.repairInsertIds.push(row.productVariantId);
        if (action === "delete") candidates.repairDeleteIds.push(row.productVariantId);
      }
      afterId = rows[rows.length - 1].productVariantId;
    }
    // Tidy: broad picks of sizes not offered now and never listed by the vendor.
    afterId = 0;
    for (;;) {
      const ids = await reads.listBroadPickIdsAfter({ vendorId, afterId, limit: FOLLOW_UP_TIDY_BATCH_SIZE });
      if (ids.length === 0) break;
      assertAscending(ids, afterId, "tidy");
      const offered = await reads.readOfferedAmong({ vendorId, productVariantIds: ids, now });
      const listed = await reads.readListedAmong({ vendorId, productVariantIds: ids });
      candidates.tidyIds.push(...ids.filter((id) => !offered.has(id) && !listed.has(id)));
      afterId = ids[ids.length - 1];
    }
    return candidates;
  }

  /** d. The one conversion notice, after the follow-up's commit; `n` is the vendor's selected count now. */
  private async sendNotice(record: SelectionConversionRecord, now: Date): Promise<void> {
    const selectedCount = await this.deps.repository.readSelectedCount({ vendorId: record.vendorId, now });
    const words = describeSelectionRulesConvertedNotice(selectedCount);
    const idempotencyKey = selectionRulesConvertedIdempotencyKey(record.vendorId);
    let outcome: "sent" | "muted" | "replayed" | "replay_mismatch";
    try {
      const sent = await this.deps.notifications.send({
        vendorId: record.vendorId, eventType: DROPSHIP_NOTIFICATION_EVENTS.SELECTION_RULES_CONVERTED, critical: false,
        title: words.title, message: words.message, payload: { selectedCount, backfillRevisionId: record.backfillRevisionId },
        idempotencyKey,
      });
      outcome = sent.idempotentReplay ? "replayed" : sent.events.length > 0 ? "sent" : "muted";
    } catch (error) {
      if (!(error instanceof DropshipError && error.code === NOTIFICATION_IDEMPOTENCY_CONFLICT)) throw error;
      // The notice went out on an earlier tick whose answer was lost, with another count: it counts as sent.
      outcome = "replay_mismatch";
      this.deps.log.debug("dropship.selection.conversion_notice_replay_mismatch", {
        outcome, vendor_id: record.vendorId, idempotency_key: idempotencyKey, selected_count: selectedCount,
      });
    }
    await this.deps.repository.markNoticeSent({ vendorId: record.vendorId, now });
    this.deps.log.info("dropship.selection.conversion_notice_sent", {
      outcome, vendor_id: record.vendorId, idempotency_key: idempotencyKey, selected_count: selectedCount,
      before: { notice_state: "pending" }, after: { notice_state: "sent" },
    });
  }

  /** A vendor's failure by class (see the module comment). Returns true when it moved the row to `requires_review`. */
  private async handleVendorFailure(record: SelectionConversionRecord, stage: "followup" | "notice", error: unknown): Promise<boolean> {
    const { errorClass, code } = classifyCatalogJobError(error);
    const base = { vendor_id: record.vendorId, stage, backfill_revision_id: record.backfillRevisionId };
    if (errorClass === "busy") {
      this.deps.log.debug("dropship.selection.conversion_followup_deferred", {
        ...base, outcome: "deferred", error_code: code, error_class: "transient",
      });
      return false;
    }
    try {
      if (errorClass === "permanent") {
        const reviewCode = (code ?? CATALOG_ARRIVALS_ERROR_CODES.followUpRequiresReview).slice(0, 80);
        await this.deps.repository.markRequiresReview({ vendorId: record.vendorId, stage, errorCode: reviewCode });
        // Never retried (CLAUDE.md §6): a later code change clears it, never a hand-run step (decision 7; R21).
        this.deps.log.error("dropship.selection.conversion_followup_requires_review", {
          ...base, outcome: "requires_review", error_code: CATALOG_ARRIVALS_ERROR_CODES.followUpRequiresReview,
          cause_code: reviewCode, error_class: "permanent", ...errorDetail(error),
          before: { [`${stage}_state`]: "pending" }, after: { [`${stage}_state`]: "requires_review", last_error_code: reviewCode },
        });
        return true;
      }
      const streak = await this.deps.repository.recordFailure({ vendorId: record.vendorId });
      const fields = {
        ...base, outcome: "deferred", error_code: code ?? CATALOG_ARRIVALS_ERROR_CODES.followUpFailed, error_class: errorClass,
        followup_failures: streak,
      };
      if (errorClass === "fatal") {
        // A fault, not the database: a human is needed, and the next tick tries again.
        this.deps.log.error("dropship.selection.conversion_followup_failed", { ...fields, outcome: "failed", ...errorDetail(error) });
      } else {
        this.deps.log.warn("dropship.selection.conversion_followup_failed", fields);
        if (streak === CATALOG_JOB_FAILURE_ALERT_STREAK) {
          this.deps.log.error("dropship.selection.conversion_followup_failed", {
            ...fields, outcome: "failed", error_code: CATALOG_ARRIVALS_ERROR_CODES.followUpFailed, cause_code: code,
          });
        }
      }
    } catch (stateError) {
      // The row's state could not be written either (the database is likely down); the next tick reads it again.
      this.deps.log.error("dropship.selection.conversion_followup_failed", {
        ...base, outcome: "failed", error_code: code ?? CATALOG_ARRIVALS_ERROR_CODES.followUpFailed, error_class: errorClass,
        ...errorDetail(error), state_write_error: stateError instanceof Error ? stateError.message : String(stateError),
      });
    }
    return false;
  }

  private logDone(record: SelectionConversionRecord, outcome: Extract<ApplyOutcome, { kind: "done" }>): void {
    const base = { vendor_id: record.vendorId, backfill_revision_id: record.backfillRevisionId, revision_id: outcome.revisionId };
    if (outcome.insertedIds.length > 0 || outcome.repairDeletedIds.length > 0) {
      // An anomaly auto-recovered (A10): the TS matcher and the SQL twin disagreed on these rows.
      this.deps.log.warn("dropship.selection.conversion_repaired", {
        ...base, outcome: "repaired",
        inserted_count: outcome.insertedIds.length, inserted_variant_ids: outcome.insertedIds.slice(0, MAX_LOGGED_IDS),
        deleted_count: outcome.repairDeletedIds.length, deleted_variant_ids: outcome.repairDeletedIds.slice(0, MAX_LOGGED_IDS),
      });
    }
    const changed = outcome.revisionId !== null;
    this.deps.log.info("dropship.selection.conversion_followed_up", {
      ...base,
      outcome: changed ? "changed" : "nothing_to_change",
      repair_allowed: outcome.repairAllowed,
      repaired_inserted: outcome.insertedIds.length,
      repaired_deleted: outcome.repairDeletedIds.length,
      tidied: outcome.tidiedIds.length,
      tidied_variant_ids: outcome.tidiedIds.slice(0, MAX_LOGGED_IDS),
      before: { followup_state: "pending" },
      after: { followup_state: "done" },
    });
  }
}

/**
 * One apply attempt (§11.2 a-c), in the repository's transaction: the
 * conversion row locked and still pending, every candidate re-checked on
 * fresh reads, then the revision, the audit, the pre-lock and the gated
 * writes in the save's order with its row-count checks (SAFETY-9), and
 * `done`. A plan that moved rolls the attempt back (retried like the save).
 */
async function applyFollowUp(tx: FollowUpApplyTransaction, input: {
  record: SelectionConversionRecord; rules: readonly DropshipVendorSelectionRule[]; candidates: FollowUpCandidates; now: Date;
}): Promise<ApplyOutcome> {
  const { record, rules, candidates, now } = input;
  const vendorId = record.vendorId;
  const locked = await tx.lockConversion(vendorId);
  if (!locked || locked.followupState !== "pending") return { kind: "not_pending", followupState: locked?.followupState ?? null };

  // a. Repair only while the vendor has not saved since the conversion (checked under the vendor lock).
  const head = await tx.readHeadRevisionId(vendorId);
  const repairAllowed = head === locked.backfillRevisionId;
  const insertedIds: number[] = [];
  const repairDeletedIds: number[] = [];
  const wantedInserts = new Set(candidates.repairInsertIds);
  const wantedDeletes = new Set(candidates.repairDeleteIds);
  if (repairAllowed) {
    for (const chunk of chunks(sortedUnique([...wantedInserts, ...wantedDeletes]), FOLLOW_UP_TIDY_BATCH_SIZE)) {
      for (const row of await tx.readRepairRows({ vendorId, productVariantIds: chunk })) {
        const action = followUpRepairAction(rules, row);
        if (action === "insert" && wantedInserts.has(row.productVariantId)) insertedIds.push(row.productVariantId);
        if (action === "delete" && wantedDeletes.has(row.productVariantId)) repairDeletedIds.push(row.productVariantId);
      }
    }
  }

  // b. Tidy: still a broad pick, still not offered, still never listed.
  const repairDeleted = new Set(repairDeletedIds);
  const tidiedIds: number[] = [];
  for (const chunk of chunks(sortedUnique(candidates.tidyIds.filter((id) => !repairDeleted.has(id))), FOLLOW_UP_TIDY_BATCH_SIZE)) {
    const broad = [...await tx.readBroadPickIds({ vendorId, productVariantIds: chunk })].sort((left, right) => left - right);
    if (broad.length === 0) continue;
    const offered = await tx.readOfferedAmong({ vendorId, productVariantIds: broad, now });
    const listed = await tx.readListedAmong({ vendorId, productVariantIds: broad });
    tidiedIds.push(...broad.filter((id) => !offered.has(id) && !listed.has(id)));
  }

  const inserts = sortedUnique(insertedIds);
  const deletes = sortedUnique([...repairDeletedIds, ...tidiedIds]);
  const changed = inserts.length > 0 || deletes.length > 0;

  // c. The revision only when something changes; the audit and `done` always, and only here.
  let revisionId: number | null = null;
  if (changed) {
    // The pick rows outside the change from their own statement; the touched rows from this attempt's own reads: every
    // delete was read as a pick of the vendor and no insert was (the save's split, SRV-1). So a size the catalog deletes
    // between those reads and this one (its pick cascades; no vendor lock stops it) never skews the count: the delete's
    // row count then re-plans the attempt.
    const untouchedPickCount = await tx.countPicksOutside({ vendorId, productVariantIds: sortedUnique([...inserts, ...deletes]) });
    const pickCountBefore = untouchedPickCount + deletes.length;
    const pickCount = pickCountBefore + inserts.length - deletes.length;
    if (untouchedPickCount < 0 || pickCount < 0) {
      throw invariantFailed("The follow-up would leave a negative pick count.", { vendorId, untouchedPickCount, pickCountBefore });
    }
    revisionId = await tx.insertRevision({
      vendorId,
      idempotencyKey: conversionFollowUpIdempotencyKey(vendorId, locked.backfillRevisionId),
      requestHash: followUpRequestHash({ vendorId, backfillRevisionId: locked.backfillRevisionId, inserts, deletes }),
      pickCount,
      result: { inserted: inserts.length, deleted: deletes.length, repaired: inserts.length + repairDeletedIds.length,
        tidied: tidiedIds.length },
      now,
    });
  }
  await tx.insertAudit({
    vendorId,
    revisionId: revisionId ?? locked.backfillRevisionId,
    now,
    payload: {
      outcome: changed ? "changed" : "nothing_to_change",
      backfillRevisionId: locked.backfillRevisionId,
      revisionId,
      repairAllowed,
      repairedInsertedVariantIds: inserts,
      repairedDeletedVariantIds: sortedUnique(repairDeletedIds),
      tidiedVariantIds: sortedUnique(tidiedIds),
      counts: { repairedInserted: inserts.length, repairedDeleted: repairDeletedIds.length, tidied: tidiedIds.length },
    },
  });
  if (inserts.length > 0) {
    const lockedIds = await tx.preLockVariants(inserts);
    if (lockedIds.length !== inserts.length) throw planMoved(vendorId, "pre_lock", inserts.length, lockedIds.length);
  }
  if (deletes.length > 0) {
    const deleted = await tx.deletePicks({ vendorId, productVariantIds: deletes });
    if (deleted !== deletes.length) throw planMoved(vendorId, "delete", deletes.length, deleted);
  }
  if (inserts.length > 0) {
    const inserted = await tx.insertRepairPicks({ vendorId, revisionId: revisionId!, productVariantIds: inserts, now });
    if (inserted !== inserts.length) throw planMoved(vendorId, "insert", inserts.length, inserted);
  }
  await tx.markFollowUpDone({ vendorId, now });
  return { kind: "done", revisionId, repairAllowed, insertedIds: inserts, repairDeletedIds: sortedUnique(repairDeletedIds),
    tidiedIds: sortedUnique(tidiedIds) };
}

/** The follow-up revision's request hash: what it changes, canonical (the backfill wrote 64 zeros; this one names its writes). */
function followUpRequestHash(input: { vendorId: number; backfillRevisionId: number; inserts: number[]; deletes: number[] }): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "picks_conversion_followup", vendorId: input.vendorId, backfillRevisionId: input.backfillRevisionId,
    inserts: input.inserts, deletes: input.deletes,
  })).digest("hex");
}

/** The save's internal retryable code (§14), so retryableSaveFailureCode retries a follow-up that moved too. */
function planMoved(vendorId: number, step: string, planned: number, actual: number): DropshipError {
  return new DropshipError(SELECTION_CHANGE_PLAN_MOVED, "The catalog changed while the conversion follow-up was being written.", {
    vendorId, step, planned, actual, classification: "transient", retryable: true,
  });
}

function assertAscending(ids: readonly number[], afterId: number, walk: string): void {
  if (ids.some((id, index) => id <= (index === 0 ? afterId : ids[index - 1]))) {
    throw invariantFailed("The conversion follow-up's cursor did not advance.", { walk, afterId });
  }
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function errorDetail(error: unknown): Record<string, unknown> {
  return {
    error_message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DropshipError && error.context ? { error_context: error.context } : {}),
  };
}
