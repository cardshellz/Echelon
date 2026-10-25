import type { ListingPushRunCounts, ListingPushRunProblem } from "../../../../shared/dropship/listing-push-runs";
import {
  MAX_RUN_NOTIFICATION_ITEMS,
  MAX_RUN_NOTICES_RECOVERED_PER_SWEEP,
  RUN_CHUNK_MAX_CONFLICT_ATTEMPTS,
  RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS,
  RUN_EXPANSION_SWEEP_BUDGET_MS,
  RUN_EXPANSIONS_PER_SWEEP,
  RUN_NOTICE_RECOVERY_WINDOW_MS,
  RUN_RECONCILE_JOB_ACTIVITY_WINDOW_MS,
  LISTING_PUSH_RUN_CODES,
  classifyChunkExpansionError,
  decideListingPushRunPrefilter,
  listingPushRunChunkJobKey,
  listingPushRunProblemCount,
  type ChunkExpansionErrorClass,
} from "../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS, describeListingPushRunProblems } from "../domain/listing-push-run-words";
import type { DropshipCostChangePolicyInForce } from "./dropship-cost-change-policy-service";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipListingPushRunRecord } from "./dropship-listing-push-run-service";
import type { DropshipClock, DropshipLogger, DropshipNotificationSender } from "./dropship-ports";
import type { CreateListingPushJobInput } from "./dropship-use-case-dtos";

/**
 * The publish run steps of the push sweep (step 1 plan S2-5, PR A, §4.3-§4.4),
 * run under the sweep's own lock before any job is processed: reconcile and
 * finish first, then expand; reconcile and finish run again after each job.
 * The item worker writes its own item's target as it decides the item (verify
 * V1), so a run's counts move with every size; the reconcile here copies item
 * outcomes to targets too, so they stay right while an older release's worker,
 * which knows nothing of runs, processes a chunk's job during a deploy (D13),
 * and after a staff retry of a finished run's job (SAFETY17).
 */

/** Pre-filter facts of one pending size (§4.3 step 2), read in one read-only transaction. */
export interface ListingPushRunChunkFacts {
  productVariantId: number;
  selected: boolean;
  /** Live on this store: a live status and an eBay listing id (the `not_live` scope's rule). */
  live: boolean;
  /**
   * eBay lists it: live, or a push-progress status with a listing id (the
   * order acceptance rule, review MC3). The price review applies to these.
   */
  onMarketplace: boolean;
  /**
   * A price input of the size moved after the press: a cost entry that took
   * effect, or was recorded, after it, or a store pricing, listing price or
   * product or category price recipe revision saved after it.
   */
  priceInputsMoved: boolean;
}

export interface ListingPushRunFinished {
  run: DropshipListingPushRunRecord;
  counts: ListingPushRunCounts;
  /** The first problem sizes (failed, not ready, price review, changed), at most the notice's own count. */
  problems: ListingPushRunProblem[];
  /** The store's name on eBay, for the email; null when the store has none on file. */
  storeName: string | null;
  /**
   * The run's failed sizes per code of RUN_UNREQUEUED_STOCK_LINK_CODES (a passing stock link condition the sweep
   * re-queues outside a run, never for a run), by code; empty when none (merge review ADV-RB2-1).
   */
  stockLinkFailuresNotRequeued: ListingPushRunCodeCount[];
}

/** How many of a run's sizes ended with one code. */
export interface ListingPushRunCodeCount {
  code: string;
  count: number;
}

export type ListingPushRunChunkFailure =
  | { kind: "conflict"; code: string; maxAttempts: number }
  | { kind: "key_conflict"; code: string }
  | { kind: "permanent"; code: string }
  | { kind: "transient"; code: string; maxAttempts: number };

export interface DropshipListingPushRunSweepRepository {
  /**
   * Copies each finished job item's outcome to its target (§4.4 step 1), for
   * the jobs of unfinished runs and any run job active within the window.
   * Set-based and idempotent; a change to a finished run's target writes an
   * audit row in the same transaction. Returns how many targets changed.
   */
  reconcileTargets(input: { now: Date; activityWindowMs: number }): Promise<{ changed: number; finishedRunChanges: number }>;
  /** Finishes every processing run with no pending or queued target, with its audit row (§4.4 step 2). */
  finishRuns(input: { now: Date; problemLimit: number }): Promise<ListingPushRunFinished[]>;
  /**
   * Finished runs whose notice step never completed (the process died between
   * the finish's commit and its email; verify V9), finished within the window,
   * oldest first.
   */
  listRunsAwaitingNotice(input: { now: Date; windowMs: number; limit: number; problemLimit: number }): Promise<ListingPushRunFinished[]>;
  /** Stamps the run's notice step as done (sent, refused by the sender and logged, or not needed). Idempotent. */
  markRunNotified(input: { runId: number; now: Date }): Promise<void>;
  /** Processing runs with no stop, a pending target and no queued or processing child job, oldest first (D11). */
  listExpandableRuns(input: { limit: number }): Promise<DropshipListingPushRunRecord[]>;
  /** The lowest chunk with a pending target and its pending sizes, or null. */
  nextPendingChunk(input: { runId: number }): Promise<{ chunkIndex: number; productVariantIds: number[] } | null>;
  /** The job carrying out this chunk, adopted by (run_id, run_chunk_index) only, never by key (SAFETY14). */
  findChunkJob(input: { runId: number; chunkIndex: number }): Promise<{ jobId: number } | null>;
  /** One read-only transaction over the chunk's sizes only (TESTS10). */
  readChunkFacts(input: { run: DropshipListingPushRunRecord; productVariantIds: readonly number[]; now: Date }): Promise<ListingPushRunChunkFacts[]>;
  /** Writes pre-filter outcomes of still-pending targets and the audit row with the ids per outcome (SAFETY22). */
  recordPrefilter(input: {
    run: DropshipListingPushRunRecord;
    chunkIndex: number;
    outcomes: ReadonlyArray<{ productVariantId: number; outcome: "skipped" | "price_review"; code: string }>;
    now: Date;
  }): Promise<{ applied: number }>;
  /** Run FOR UPDATE: true while the run is processing with no stop requested (§4.3 step 3). */
  isRunOpenForQueue(input: { runId: number }): Promise<boolean>;
  /**
   * One transaction (§4.3 step 4): run FOR UPDATE; a stop that raced the queue
   * cancels the job's queued items and the chunk's targets; otherwise targets
   * take their items' state. Then the chunk pointer moves on and the attempts
   * reset, with the audit row.
   */
  recordChunkQueued(input: { run: DropshipListingPushRunRecord; chunkIndex: number; jobId: number; now: Date }): Promise<{
    stopped: boolean; queued: number; decided: number; notQueued: number;
  }>;
  /**
   * Counts a failed queue attempt of the chunk and, at its limit, decides the chunk's pending targets (§4.3 step 5).
   * A chunk a job already carries is never decided (the next sweep adopts and records it); `chunkJobExists` says so.
   */
  recordChunkFailure(input: {
    run: DropshipListingPushRunRecord; chunkIndex: number; failure: ListingPushRunChunkFailure; message: string; now: Date;
  }): Promise<{ attempts: number; decided: number; chunkJobExists: boolean }>;
  /**
   * A refusal that names one product (verify V6): that product's pending sizes in the chunk fail for good, with the
   * audit row, and the rest stay pending for the next sweep. A chunk a job already carries is never decided here.
   */
  recordChunkProductFailure(input: {
    run: DropshipListingPushRunRecord; chunkIndex: number; productId: number; code: string; message: string; now: Date;
  }): Promise<{ decided: number; chunkJobExists: boolean }>;
}

/** The sizes a price check previews, and whether each is rule priced (INTENT:66-67's test). */
export type ListingPushRunPriceCheck = (input: {
  vendorId: number; storeConnectionId: number; productVariantIds: readonly number[];
}) => Promise<Array<{ productVariantId: number; rulePriced: boolean }>>;

export interface DropshipListingPushRunSweepDependencies {
  repository: DropshipListingPushRunSweepRepository;
  /** DropshipListingPreviewService.createListingPushJob: the one way a push job is created. */
  createChunkJob: (input: CreateListingPushJobInput) => Promise<{ job: { jobId: number } }>;
  priceCheck: ListingPushRunPriceCheck;
  resolveCostChangePolicy: () => Promise<DropshipCostChangePolicyInForce>;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  /** A monotonic millisecond reading, for the sweep's expansion budget only (never a business time). */
  timer: () => number;
  logger: DropshipLogger;
}

export class DropshipListingPushRunSweepService {
  constructor(private readonly deps: DropshipListingPushRunSweepDependencies) {}

  /** §4.4: copy item outcomes to targets, then finish runs with nothing left, then notify after commit. */
  async reconcileAndFinish(): Promise<{ changed: number; finished: number }> {
    const now = this.deps.clock.now();
    const reconciled = await this.deps.repository.reconcileTargets({ now, activityWindowMs: RUN_RECONCILE_JOB_ACTIVITY_WINDOW_MS });
    if (reconciled.finishedRunChanges > 0) {
      // A finished run changed after its finish: Card Shellz staff retried one of its jobs (SAFETY17). Neither automatic
      // requeue picks a run's job (the account check's accountRefusalCandidateSql and the stock link's
      // stockLinkCandidateSql, ops repository); during a deploy an older release's requeue, which knows no runs, still can.
      this.deps.logger.info({
        code: "DROPSHIP_LISTING_PUSH_RUN_TARGETS_CHANGED_AFTER_FINISH",
        message: "Targets of finished publish runs changed after the run finished; audit rows were written.",
        context: { changed: reconciled.finishedRunChanges },
      });
    }
    const finished = await this.deps.repository.finishRuns({ now, problemLimit: MAX_RUN_NOTIFICATION_ITEMS });
    for (const result of finished) {
      this.deps.logger.info({
        code: "DROPSHIP_LISTING_PUSH_RUN_FINISHED",
        message: "A publish run finished.",
        context: { runId: result.run.runId, vendorId: result.run.vendorId, storeConnectionId: result.run.storeConnectionId,
          status: result.run.status, stopReason: result.run.stopReason, counts: result.counts },
      });
      this.logStockLinkFailuresNotRequeued(result);
      await this.notifyFinishedRun(result);
    }
    // A finish whose notice step never completed, because the process died after the finish committed (verify V9):
    // its email goes now, under the same key, so a notice that did go out is replayed, never sent twice.
    const awaiting = await this.deps.repository.listRunsAwaitingNotice({
      now, windowMs: RUN_NOTICE_RECOVERY_WINDOW_MS, limit: MAX_RUN_NOTICES_RECOVERED_PER_SWEEP, problemLimit: MAX_RUN_NOTIFICATION_ITEMS,
    });
    for (const result of awaiting) {
      // WARN: an anomaly recovered by itself (CLAUDE.md §10).
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_PUSH_RUN_NOTICE_RECOVERED",
        message: "A finished publish run's notice step had not completed; it ran now.",
        context: { runId: result.run.runId, vendorId: result.run.vendorId, storeConnectionId: result.run.storeConnectionId,
          status: result.run.status, completedAt: result.run.completedAt?.toISOString() ?? null },
      });
      // The finish's own lines may not have been written either: the process died after the finish committed.
      this.logStockLinkFailuresNotRequeued(result);
      await this.notifyFinishedRun(result);
    }
    return { changed: reconciled.changed, finished: finished.length };
  }

  /**
   * §4.3: expand at most RUN_EXPANSIONS_PER_SWEEP runs, oldest first, one
   * chunk each, and start none once the budget is spent. A failure of one run
   * is counted on that run and never stops the others.
   */
  async expandRuns(): Promise<{ attempted: number; queued: number }> {
    const started = this.deps.timer();
    const runs = await this.deps.repository.listExpandableRuns({ limit: RUN_EXPANSIONS_PER_SWEEP });
    let attempted = 0;
    let queued = 0;
    for (const run of runs) {
      if (this.deps.timer() - started >= RUN_EXPANSION_SWEEP_BUDGET_MS) {
        this.deps.logger.info({
          code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_BUDGET_SPENT",
          message: "The sweep's expansion budget is spent; the remaining runs expand at the next sweep.",
          context: { budgetMs: RUN_EXPANSION_SWEEP_BUDGET_MS, attempted, remaining: runs.length - attempted },
        });
        break;
      }
      attempted += 1;
      if (await this.expandRun(run)) queued += 1;
    }
    return { attempted, queued };
  }

  /** One chunk of one run. True when a chunk job was queued (or adopted) and recorded. */
  private async expandRun(run: DropshipListingPushRunRecord): Promise<boolean> {
    const chunk = await this.deps.repository.nextPendingChunk({ runId: run.runId });
    if (!chunk) return false;
    try {
      // 1. Adopt: a crash after the chunk job committed leaves it for this sweep to record.
      const adopted = await this.deps.repository.findChunkJob({ runId: run.runId, chunkIndex: chunk.chunkIndex });
      if (adopted) {
        await this.record(run, chunk.chunkIndex, adopted.jobId, "adopted");
        return true;
      }
      // 2. Pre-filter the chunk's own sizes.
      const remaining = await this.prefilter(run, chunk.chunkIndex, chunk.productVariantIds);
      if (remaining.length === 0) return false;
      // 3. Queue, unless a stop came first.
      if (!(await this.deps.repository.isRunOpenForQueue({ runId: run.runId }))) return false;
      const created = await this.deps.createChunkJob({
        vendorId: run.vendorId,
        storeConnectionId: run.storeConnectionId,
        productVariantIds: remaining,
        reviewMode: "current_preview",
        idempotencyKey: listingPushRunChunkJobKey({ vendorId: run.vendorId, runId: run.runId, chunkIndex: chunk.chunkIndex }),
        requestedBy: { actorType: run.actorType, ...(run.actorId ? { actorId: run.actorId } : {}) },
        run: { runId: run.runId, chunkIndex: chunk.chunkIndex },
      });
      // 4. Record. The sweep runs expansion before any job, so no item of this job started in between.
      await this.record(run, chunk.chunkIndex, created.job.jobId, "created");
      return true;
    } catch (error) {
      await this.recordFailure(run, chunk.chunkIndex, error);
      return false;
    }
  }

  private async prefilter(run: DropshipListingPushRunRecord, chunkIndex: number, productVariantIds: readonly number[]): Promise<number[]> {
    const now = this.deps.clock.now();
    const facts = await this.deps.repository.readChunkFacts({ run, productVariantIds, now });
    const factsById = new Map(facts.map((row) => [row.productVariantId, row]));
    const policy = await this.deps.resolveCostChangePolicy();
    const waitsForReview = policy.settings.rulePricedListings === "wait_for_review";
    const outcomes: Array<{ productVariantId: number; outcome: "skipped" | "price_review"; code: string }> = [];
    const needsPriceCheck: number[] = [];
    const kept: number[] = [];
    for (const productVariantId of productVariantIds) {
      const row = factsById.get(productVariantId)
        ?? { productVariantId, selected: false, live: false, onMarketplace: false, priceInputsMoved: false };
      const decision = decideListingPushRunPrefilter({
        scope: run.scope,
        facts: { selected: row.selected, live: row.live, onMarketplace: row.onMarketplace,
          priceMovedAfterPress: waitsForReview && row.priceInputsMoved },
      });
      if (decision === null) kept.push(productVariantId);
      else if (decision.outcome === "needs_price_check") needsPriceCheck.push(productVariantId);
      else outcomes.push({ productVariantId, outcome: decision.outcome, code: decision.code });
    }
    if (needsPriceCheck.length > 0) {
      // One read-only preview of the sizes whose price inputs moved (SAFETY8, D29): a rule-priced one waits for the
      // vendor's review, because a chunk queued later would otherwise measure "moved since queueing" from expansion.
      const checked = await this.deps.priceCheck({ vendorId: run.vendorId, storeConnectionId: run.storeConnectionId,
        productVariantIds: needsPriceCheck });
      const rulePriced = new Set(checked.filter((row) => row.rulePriced).map((row) => row.productVariantId));
      for (const productVariantId of needsPriceCheck) {
        if (rulePriced.has(productVariantId)) {
          outcomes.push({ productVariantId, outcome: "price_review", code: LISTING_PUSH_RUN_CODES.priceAwaitingReview });
        } else {
          kept.push(productVariantId);
        }
      }
    }
    if (outcomes.length > 0) {
      await this.deps.repository.recordPrefilter({ run, chunkIndex, outcomes, now: this.deps.clock.now() });
      this.deps.logger.info({
        code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_PREFILTERED",
        message: "Sizes of a publish run chunk were left out before queueing.",
        context: { runId: run.runId, vendorId: run.vendorId, storeConnectionId: run.storeConnectionId, chunkIndex,
          skipped: outcomes.filter((row) => row.outcome === "skipped").length,
          priceReview: outcomes.filter((row) => row.outcome === "price_review").length },
      });
    }
    return kept.sort((left, right) => left - right);
  }

  private async record(run: DropshipListingPushRunRecord, chunkIndex: number, jobId: number, how: "created" | "adopted"): Promise<void> {
    const recorded = await this.deps.repository.recordChunkQueued({ run, chunkIndex, jobId, now: this.deps.clock.now() });
    const context = { runId: run.runId, vendorId: run.vendorId, storeConnectionId: run.storeConnectionId, chunkIndex, jobId,
      how, ...recorded };
    if (recorded.notQueued > 0) {
      // Every pending size of a chunk is in its job: the job writes one item per requested size. A size left
      // over failed for good so its run can finish; a human must look at why the job left it out.
      this.deps.logger.error({
        code: LISTING_PUSH_RUN_CODES.targetNotQueued,
        message: "A publish run chunk's job has no item for some of its sizes; they were failed.",
        context,
      });
    }
    this.deps.logger.info({
      code: recorded.stopped ? "DROPSHIP_LISTING_PUSH_RUN_CHUNK_CANCELLED" : "DROPSHIP_LISTING_PUSH_RUN_CHUNK_QUEUED",
      message: recorded.stopped
        ? "A stop raced a publish run chunk's queue: its queued items were cancelled."
        : "A publish run chunk was queued as a push job.",
      context,
    });
  }

  private async recordFailure(run: DropshipListingPushRunRecord, chunkIndex: number, error: unknown): Promise<void> {
    const classified = classifyChunkExpansionError(error);
    const failure = chunkFailure(classified);
    const message = "message" in classified ? classified.message : String((error as Error)?.message ?? error);
    const context = { runId: run.runId, vendorId: run.vendorId, storeConnectionId: run.storeConnectionId, chunkIndex,
      errorKind: classified.kind, errorCode: classified.code, error: error instanceof Error ? error.message : String(error) };
    if (classified.kind === "permanent" && classified.productId !== undefined) {
      // One product's refusal (its stock could not be read): only its sizes fail; the rest of the chunk is queued at the
      // next sweep instead of failing with it (verify V6). Nothing of it pending in the chunk: the whole chunk below.
      let productRecorded: { decided: number; chunkJobExists: boolean };
      try {
        productRecorded = await this.deps.repository.recordChunkProductFailure({
          run, chunkIndex, productId: classified.productId, code: classified.code, message, now: this.deps.clock.now(),
        });
      } catch (recordError) {
        this.deps.logger.error({
          code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_FAILURE_NOT_RECORDED",
          message: "A publish run chunk failed and its failure could not be recorded; the next sweep retries it.",
          context: { ...context, productId: classified.productId,
            recordError: recordError instanceof Error ? recordError.message : String(recordError) },
        });
        return;
      }
      if (productRecorded.decided > 0) {
        this.deps.logger.info({
          code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_PRODUCT_REFUSED",
          message: "One product of a publish run chunk was refused for good; its sizes failed and the rest of the chunk goes on.",
          context: { ...context, productId: classified.productId, decided: productRecorded.decided },
        });
        return;
      }
    }
    let recorded: { attempts: number; decided: number; chunkJobExists: boolean };
    try {
      recorded = await this.deps.repository.recordChunkFailure({ run, chunkIndex, failure, message, now: this.deps.clock.now() });
    } catch (recordError) {
      // The failure could not even be counted: nothing was decided, the next sweep tries the chunk again.
      this.deps.logger.error({
        code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_FAILURE_NOT_RECORDED",
        message: "A publish run chunk failed and its failure could not be recorded; the next sweep retries it.",
        context: { ...context, recordError: recordError instanceof Error ? recordError.message : String(recordError) },
      });
      return;
    }
    const logged = { ...context, attempts: recorded.attempts, decided: recorded.decided, chunkJobExists: recorded.chunkJobExists };
    if (recorded.chunkJobExists && recorded.attempts >= RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS) {
      // The chunk's job exists, so its sizes are never decided here, and only recording the job lets the run go on:
      // every sweep tries again. ERROR once, when the attempts reach the limit (a human must see why the record keeps
      // failing; the store can start no other run meanwhile), then INFO, so a stuck chunk is no WARN every 10 s
      // (CLAUDE.md §6, §10; review round 2 MC3).
      const atLimit = recorded.attempts === RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS;
      this.deps.logger[atLimit ? "error" : "info"]({
        code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RECORD_STUCK",
        message: "A publish run chunk's job exists but could not be recorded; every sweep tries again.",
        context: logged,
      });
    } else if (classified.kind === "key_conflict" || (classified.kind === "transient" && recorded.decided > 0)) {
      // ERROR: a key collision, or a chunk that kept failing for a passing reason, needs a human (CLAUDE.md §6).
      this.deps.logger.error({ code: failure.code, message: "A publish run chunk could not be queued and was failed.", context: logged });
    } else if (classified.kind === "transient") {
      this.deps.logger.warn({ code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RETRYING", message: "A publish run chunk could not be queued; the next sweep tries again.", context: logged });
    } else if (classified.kind === "conflict") {
      this.deps.logger.info({ code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_CONFLICT", message: "A publish run chunk changed while it was queued.", context: logged });
    } else {
      this.deps.logger.info({ code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_REFUSED", message: "A publish run chunk was refused for good; its sizes failed.", context: logged });
    }
  }

  /**
   * The run's one notice when any size did not publish, then the stamp that
   * its notice step is done (verify V9). A sender failure is logged by
   * sendDropshipNotificationSafely and is not retried, as a job's notice never
   * was; only a notice step a dead process never finished runs again.
   */
  /**
   * One line per finished run with sizes that failed for a stock link reason that usually clears by itself (merge
   * review ADV-RB2-1). Outside a run the sweep queues such a size again by itself and logs an ERROR once its re-queues
   * run out; a run's chunk is never re-queued (stockLinkCandidateSql), its card asks the vendor to publish again, so
   * this line is what tells Card Shellz how often runs end that way. WARN, not ERROR (CLAUDE.md §10): the vendor's own
   * step clears it and no one at Card Shellz has to act; ERROR stays for a condition that outlasted every automatic
   * try. Written again only when a dead process's finish is recovered (its notice step was still open).
   */
  private logStockLinkFailuresNotRequeued(result: ListingPushRunFinished): void {
    const failures = result.stockLinkFailuresNotRequeued;
    if (failures.length === 0) return;
    this.deps.logger.warn({
      code: "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED",
      message: "Sizes of a finished publish run failed for a stock link reason that usually clears by itself. A publish run does not queue them again by itself; the vendor was asked to publish again.",
      context: {
        action: "finish_publish_run", outcome: "not_requeued",
        runId: result.run.runId, vendorId: result.run.vendorId, storeConnectionId: result.run.storeConnectionId,
        status: result.run.status,
        failedSizes: failures.reduce((sum, failure) => sum + failure.count, 0),
        failures: failures.map((failure) => ({ code: failure.code, count: failure.count })),
      },
    });
  }

  private async notifyFinishedRun(result: ListingPushRunFinished): Promise<void> {
    const problemCount = listingPushRunProblemCount(result.counts);
    if (problemCount > 0) await this.sendRunNotice(result, problemCount);
    await this.deps.repository.markRunNotified({ runId: result.run.runId, now: this.deps.clock.now() });
  }

  private async sendRunNotice(result: ListingPushRunFinished, problemCount: number): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.run.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.LISTING_PUSH_FAILED,
      critical: true,
      channels: ["email", "in_app"],
      title: LISTING_PUSH_RUN_WORDS.emailTitle,
      message: describeListingPushRunProblems({ problemCount, targetCount: result.run.targetCount, stopReason: result.run.stopReason,
        storeName: result.storeName, problems: result.problems.slice(0, MAX_RUN_NOTIFICATION_ITEMS) }),
      payload: {
        runId: result.run.runId,
        storeConnectionId: result.run.storeConnectionId,
        status: result.run.status,
        stopReason: result.run.stopReason,
        counts: result.counts,
        problems: result.problems.slice(0, MAX_RUN_NOTIFICATION_ITEMS).map((problem) => ({
          productVariantId: problem.productVariantId, sku: problem.sku, productName: problem.productName,
          variantName: problem.variantName, outcome: problem.outcome, code: problem.code, message: problem.message,
        })),
        omittedProblemCount: Math.max(0, problemCount - Math.min(result.problems.length, MAX_RUN_NOTIFICATION_ITEMS)),
      },
      idempotencyKey: `listing-push-run:${result.run.runId}:finished`,
    }, {
      code: "DROPSHIP_LISTING_PUSH_RUN_NOTIFICATION_FAILED",
      message: "A publish run's finish notification failed after the run finished.",
      context: { runId: result.run.runId, vendorId: result.run.vendorId, storeConnectionId: result.run.storeConnectionId, problemCount },
    });
  }
}

function chunkFailure(classified: ChunkExpansionErrorClass): ListingPushRunChunkFailure {
  switch (classified.kind) {
    case "conflict": return { kind: "conflict", code: LISTING_PUSH_RUN_CODES.chunkConflict, maxAttempts: RUN_CHUNK_MAX_CONFLICT_ATTEMPTS };
    case "key_conflict": return { kind: "key_conflict", code: LISTING_PUSH_RUN_CODES.keyConflict };
    case "permanent": return { kind: "permanent", code: classified.code };
    case "transient": return { kind: "transient", code: LISTING_PUSH_RUN_CODES.expansionFailed, maxAttempts: RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS };
  }
}
