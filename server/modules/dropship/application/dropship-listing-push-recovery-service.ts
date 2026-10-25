import type { DropshipClock, DropshipLogger } from "./dropship-ports";

/**
 * Automatic recovery the listing push sweep runs before it claims jobs, under
 * the sweep's advisory lock. It repairs what pushes wrote before the live
 * listing and account checks were fixed, with no manual step:
 * 1. a listing an earlier queue or failed push moved out of its live status
 *    gets the status its last completed push left (it never stopped being for
 *    sale), so it takes orders again;
 * 2. a push refused only because the store's eBay identity was not verified
 *    (the push-time account check, which before part 1 misread every store,
 *    or the stock gate's identity check) is queued again, for a listing that
 *    is live and a store that is verified now; the push-time refresh then
 *    sends current price, content and quantity.
 * Both are idempotent: a restored listing is live and no longer selected, a
 * requeued item carries a marker counting its automatic requeues, which stop
 * at a small cap (a deploy's overlap can refuse one again). A step that fails
 * is logged and tried again on the next pass; the sweep still runs.
 * 3. (Fix PR 2a-2, when configured) a push the automatic stock link failed for a
 *    reason that clears by itself is queued again after a growing wait, a
 *    bounded number of times; a push that failed with
 *    PUBLICATION_LISTING_TARGET_UNMAPPED before the link existed is re-sent
 *    once, only when its store has one live Card Shellz stock destination and the
 *    listing is still selected (owner decision Q4). Marker-guarded and audited
 *    in the same transaction as the re-queue (domain/listing-push-automatic-requeue).
 */

export type DropshipRecoveryErrorClass = "transient" | "permanent";

export interface DropshipRecoveryRowFailure {
  entity: "dropship_vendor_listing" | "dropship_listing_push_job" | "dropship_store_connection";
  entityId: number;
  code: string;
  message: string;
  classification: DropshipRecoveryErrorClass;
  /** A permanent failure is marked so the row is not tried again; false when even the mark failed. */
  markedForReview: boolean;
  /** The same passing failure again, right after an earlier one (logged at DEBUG, not as a repeated WARN). */
  repeated?: boolean;
}

export interface RestoredLiveListing {
  listingId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  previousStatus: string;
  status: "active" | "paused";
  /** The completed push item whose mode decided the status. */
  basisItemId: number;
  /** The newer item whose queue or failure had moved the listing out of its live status. */
  latestItemId: number;
  latestItemStatus: string | null;
  latestItemErrorCode: string | null;
}

export interface LiveListingReviewRequired {
  listingId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  status: string;
  code: string;
  message: string;
}

export interface DemotedLiveListingRepairResult {
  restored: RestoredLiveListing[];
  reviewRequired: LiveListingReviewRequired[];
  failed: DropshipRecoveryRowFailure[];
  /** Rows another writer held, or whose state changed before the lock was taken. */
  skipped: number;
}

export interface DropshipLiveListingStatusRepairPort {
  restoreDemotedLiveListings(input: { now: Date; workerId: string; limit: number }): Promise<DemotedLiveListingRepairResult>;
}

export interface RequeuedAccountVerificationJob {
  jobId: number;
  vendorId: number;
  storeConnectionId: number;
  itemIds: number[];
  listingIds: number[];
  idempotencyKey: string;
  /**
   * Per item: the refusal's code, whether the store was verified before that
   * failure (the failure was the earlier misread) or only after it (a real
   * refusal the vendor cleared by reconnecting), and which automatic requeue.
   */
  items?: Array<{ itemId: number; errorCode: string; basis: "verified_before_failure" | "verified_after_failure"; attempt: number }>;
}

export interface AccountVerificationRequeueResult {
  requeued: RequeuedAccountVerificationJob[];
  failed: DropshipRecoveryRowFailure[];
}

export interface DropshipAccountVerificationRequeuePort {
  requeueAccountVerificationFailures(input: { now: Date; workerId: string; limit: number }): Promise<AccountVerificationRequeueResult>;
}

export interface StockLinkRequeuedJob {
  jobId: number;
  vendorId: number;
  storeConnectionId: number;
  itemIds: number[];
  listingIds: number[];
  /** Per item: the failure's code and which automatic re-queue this is (1-based). */
  items: Array<{ itemId: number; errorCode: string; attempt: number }>;
}

export interface StockLinkRequeueItemOutcome {
  jobId: number;
  itemId: number;
  listingId: number | null;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  errorCode: string;
  /** Automatic re-queues the item already had. */
  count: number;
  /** For a skipped re-send: why it was not sent (the stock selection's decision). */
  reason?: string;
}

export interface StockLinkRequeueResult {
  requeued: StockLinkRequeuedJob[];
  /** Failed again after its code's last automatic re-queue; marked once, a human looks. */
  exhausted: StockLinkRequeueItemOutcome[];
  /** Q4 re-sends not sent because the listing is no longer selected; marked once, never re-sent. */
  skipped: StockLinkRequeueItemOutcome[];
  /** Q4 re-sends not sent yet because the listing is only paused or its store mode is off for now; looked at again later, nothing written. */
  deferred: StockLinkRequeueItemOutcome[];
  failed: DropshipRecoveryRowFailure[];
}

export interface DropshipStockLinkRequeuePort {
  requeueAutomaticStockLinkFailures(input: { now: Date; workerId: string; limit: number }): Promise<StockLinkRequeueResult>;
}

export interface DropshipListingPushRecoveryResult {
  listingsRestored: number;
  listingsNeedingReview: number;
  jobsRequeued: number;
  itemsRequeued: number;
  rowFailures: number;
  stepFailures: number;
  /** Present only when the stock link re-queue step is configured (it is included in jobs/items requeued above). */
  stockLink?: { jobsRequeued: number; itemsRequeued: number; itemsExhausted: number; itemsSkipped: number };
}

/** Bounded per pass so recovery never delays the sweep's own jobs for long. */
export const LISTING_RECOVERY_BATCH_SIZE = 50;

export class DropshipListingPushRecoveryService {
  constructor(private readonly deps: {
    liveStatusRepair: DropshipLiveListingStatusRepairPort;
    accountVerificationRequeue: DropshipAccountVerificationRequeuePort;
    /** Fix PR 2a-2's automatic stock link re-queue; absent, the step does not run. */
    stockLinkRequeue?: DropshipStockLinkRequeuePort;
    /** Its own bound (domain AUTOMATIC_REQUEUE_BATCH_SIZE in production). */
    stockLinkBatchSize?: number;
    clock: DropshipClock;
    logger: DropshipLogger;
    batchSize?: number;
  }) {}

  async run(input: { workerId: string }): Promise<DropshipListingPushRecoveryResult> {
    const result: DropshipListingPushRecoveryResult = {
      listingsRestored: 0, listingsNeedingReview: 0, jobsRequeued: 0, itemsRequeued: 0, rowFailures: 0, stepFailures: 0,
    };
    const limit = this.deps.batchSize ?? LISTING_RECOVERY_BATCH_SIZE;
    // Status first: a listing restored here is live when its requeued item runs.
    await this.step("restore_live_listing_status", input.workerId, result, async () => {
      const repair = await this.deps.liveStatusRepair.restoreDemotedLiveListings({ now: this.deps.clock.now(), workerId: input.workerId, limit });
      for (const listing of repair.restored) this.logRestored(listing, input.workerId);
      for (const listing of repair.reviewRequired) this.logReviewRequired(listing, input.workerId);
      for (const failure of repair.failed) this.logRowFailure("restore_live_listing_status", failure, input.workerId);
      result.listingsRestored += repair.restored.length;
      result.listingsNeedingReview += repair.reviewRequired.length;
      result.rowFailures += repair.failed.length;
    });
    await this.step("requeue_account_verification_failures", input.workerId, result, async () => {
      const requeue = await this.deps.accountVerificationRequeue.requeueAccountVerificationFailures({
        now: this.deps.clock.now(), workerId: input.workerId, limit,
      });
      for (const job of requeue.requeued) {
        this.deps.logger.info({
          code: "DROPSHIP_LISTING_PUSH_ACCOUNT_CHECK_REQUEUED",
          message: "A push refused by an eBay account check was queued again automatically; the store's eBay identity is verified now.",
          context: {
            action: "requeue_account_verification_failure", outcome: "requeued", workerId: input.workerId,
            jobId: job.jobId, vendorId: job.vendorId, storeConnectionId: job.storeConnectionId,
            itemIds: job.itemIds, listingIds: job.listingIds, idempotencyKey: job.idempotencyKey, items: job.items ?? [],
            before: { jobStatus: "failed", itemStatus: "failed" }, after: { jobStatus: "queued", itemStatus: "queued" },
          },
        });
      }
      for (const failure of requeue.failed) this.logRowFailure("requeue_account_verification_failures", failure, input.workerId);
      result.jobsRequeued += requeue.requeued.length;
      result.itemsRequeued += requeue.requeued.reduce((sum, job) => sum + job.itemIds.length, 0);
      result.rowFailures += requeue.failed.length;
    });
    const stockLinkRequeue = this.deps.stockLinkRequeue;
    if (stockLinkRequeue) {
      const summary = { jobsRequeued: 0, itemsRequeued: 0, itemsExhausted: 0, itemsSkipped: 0 };
      result.stockLink = summary;
      await this.step("requeue_stock_link_failures", input.workerId, result, async () => {
        const requeue = await stockLinkRequeue.requeueAutomaticStockLinkFailures({
          now: this.deps.clock.now(), workerId: input.workerId, limit: this.deps.stockLinkBatchSize ?? limit,
        });
        for (const job of requeue.requeued) this.logStockLinkRequeued(job, input.workerId);
        for (const item of requeue.exhausted) this.logStockLinkExhausted(item, input.workerId);
        for (const item of requeue.skipped) this.logStockLinkSkipped(item, input.workerId);
        for (const item of requeue.deferred ?? []) this.logStockLinkDeferred(item, input.workerId);
        for (const failure of requeue.failed) this.logRowFailure("requeue_stock_link_failures", failure, input.workerId);
        const items = requeue.requeued.reduce((sum, job) => sum + job.itemIds.length, 0);
        summary.jobsRequeued += requeue.requeued.length;
        summary.itemsRequeued += items;
        summary.itemsExhausted += requeue.exhausted.length;
        summary.itemsSkipped += requeue.skipped.length;
        result.jobsRequeued += requeue.requeued.length;
        result.itemsRequeued += items;
        result.rowFailures += requeue.failed.length;
      });
    }
    return result;
  }

  private logStockLinkRequeued(job: StockLinkRequeuedJob, workerId: string): void {
    // INFO: a state transition the push sweep makes by itself.
    this.deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_STOCK_LINK_REQUEUED",
      message: "A push the stock link failed for a passing reason, or that failed before the automatic stock link existed, was queued again automatically.",
      context: {
        action: "requeue_stock_link_failure", outcome: "requeued", workerId,
        jobId: job.jobId, vendorId: job.vendorId, storeConnectionId: job.storeConnectionId,
        itemIds: job.itemIds, listingIds: job.listingIds, items: job.items,
        before: { jobStatus: "failed", itemStatus: "failed" }, after: { jobStatus: "queued", itemStatus: "queued" },
      },
    });
  }

  private logStockLinkExhausted(item: StockLinkRequeueItemOutcome, workerId: string): void {
    // ERROR: the condition did not clear after every automatic re-queue; a human decides.
    this.deps.logger.error({
      code: "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_EXHAUSTED",
      message: "A listing push failed again after its last automatic re-queue; it is not queued again automatically.",
      context: {
        action: "requeue_stock_link_failure", outcome: "requires_review", classification: "permanent", workerId,
        jobId: item.jobId, itemId: item.itemId, listingId: item.listingId, vendorId: item.vendorId,
        storeConnectionId: item.storeConnectionId, productVariantId: item.productVariantId,
        error_code: item.errorCode, automaticRequeues: item.count,
        before: { state: null }, after: { state: "exhausted" },
      },
    });
  }

  private logStockLinkSkipped(item: StockLinkRequeueItemOutcome, workerId: string): void {
    // INFO: an expected terminal decision (the vendor deselected the listing); not an anomaly.
    this.deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_STOCK_LINK_RESEND_SKIPPED",
      message: "A push that failed before the automatic stock link existed was not sent again: the listing is no longer selected.",
      context: {
        action: "requeue_stock_link_failure", outcome: "skipped", workerId,
        jobId: item.jobId, itemId: item.itemId, listingId: item.listingId, vendorId: item.vendorId,
        storeConnectionId: item.storeConnectionId, productVariantId: item.productVariantId,
        error_code: item.errorCode, reason: item.reason ?? null,
        before: { state: null }, after: { state: "skipped" },
      },
    });
  }

  private logStockLinkDeferred(item: StockLinkRequeueItemOutcome, workerId: string): void {
    // DEBUG: an expected wait (the listing is paused or its store mode is off for now); nothing changed.
    this.deps.logger.debug?.({
      code: "DROPSHIP_LISTING_PUSH_STOCK_LINK_RESEND_DEFERRED",
      message: "A push that failed before the automatic stock link existed waits: its listing is not eligible right now.",
      context: {
        action: "requeue_stock_link_failure", outcome: "deferred", workerId,
        jobId: item.jobId, itemId: item.itemId, listingId: item.listingId, vendorId: item.vendorId,
        storeConnectionId: item.storeConnectionId, productVariantId: item.productVariantId,
        error_code: item.errorCode, reason: item.reason ?? null,
        before: { state: null }, after: { state: null },
      },
    });
  }

  /**
   * One recovery step. A whole-step failure (for example the database is
   * unreachable) is logged for a human and retried on the next pass; it never
   * stops the sweep from processing the jobs it was started for.
   */
  private async step(name: string, workerId: string, result: DropshipListingPushRecoveryResult, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      result.stepFailures += 1;
      this.deps.logger.error({
        code: "DROPSHIP_LISTING_PUSH_RECOVERY_STEP_FAILED",
        message: "A listing push recovery step failed; it runs again on the next sweep.",
        context: {
          action: name, outcome: "failed", classification: "transient", workerId,
          error: error instanceof Error ? error.message : String(error),
          errorCode: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null,
        },
      });
    }
  }

  private logRestored(listing: RestoredLiveListing, workerId: string): void {
    // WARN: an anomaly an earlier push left behind, recovered automatically.
    this.deps.logger.warn({
      code: "DROPSHIP_LISTING_LIVE_STATUS_RESTORED",
      message: "A live listing an earlier queue or failed push had made non-orderable got its live status back.",
      context: {
        action: "restore_live_listing_status", outcome: "restored", workerId,
        listingId: listing.listingId, vendorId: listing.vendorId, storeConnectionId: listing.storeConnectionId,
        productVariantId: listing.productVariantId, basisItemId: listing.basisItemId, latestItemId: listing.latestItemId,
        latestItemStatus: listing.latestItemStatus, latestItemErrorCode: listing.latestItemErrorCode,
        before: { status: listing.previousStatus }, after: { status: listing.status },
      },
    });
  }

  private logReviewRequired(listing: LiveListingReviewRequired, workerId: string): void {
    // ERROR: the evidence does not say which status is right; a human decides.
    this.deps.logger.error({
      code: listing.code,
      message: listing.message,
      context: {
        action: "restore_live_listing_status", outcome: "requires_review", classification: "permanent", workerId,
        listingId: listing.listingId, vendorId: listing.vendorId, storeConnectionId: listing.storeConnectionId,
        productVariantId: listing.productVariantId, before: { status: listing.status }, after: { status: listing.status },
        error_code: listing.code,
      },
    });
  }

  private logRowFailure(action: string, failure: DropshipRecoveryRowFailure, workerId: string): void {
    const event = {
      code: "DROPSHIP_LISTING_PUSH_RECOVERY_ROW_FAILED",
      message: failure.classification === "permanent"
        ? "A listing push recovery row failed for good; it is marked for review and not tried again."
        : "A listing push recovery row failed; it is tried again on the next sweep.",
      context: {
        action, outcome: "failed", classification: failure.classification, workerId,
        entity: failure.entity, entityId: failure.entityId, error_code: failure.code, error: failure.message,
        markedForReview: failure.markedForReview,
      },
    };
    if (failure.classification === "permanent") this.deps.logger.error(event);
    // The same passing failure again right after the first: an expected state, not a new anomaly.
    else if (failure.repeated) this.deps.logger.debug?.(event);
    else this.deps.logger.warn(event);
  }
}
