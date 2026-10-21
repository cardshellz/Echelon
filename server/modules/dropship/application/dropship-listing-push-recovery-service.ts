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
 */

export type DropshipRecoveryErrorClass = "transient" | "permanent";

export interface DropshipRecoveryRowFailure {
  entity: "dropship_vendor_listing" | "dropship_listing_push_job";
  entityId: number;
  code: string;
  message: string;
  classification: DropshipRecoveryErrorClass;
  /** A permanent failure is marked so the row is not tried again; false when even the mark failed. */
  markedForReview: boolean;
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

export interface DropshipListingPushRecoveryResult {
  listingsRestored: number;
  listingsNeedingReview: number;
  jobsRequeued: number;
  itemsRequeued: number;
  rowFailures: number;
  stepFailures: number;
}

/** Bounded per pass so recovery never delays the sweep's own jobs for long. */
export const LISTING_RECOVERY_BATCH_SIZE = 50;

export class DropshipListingPushRecoveryService {
  constructor(private readonly deps: {
    liveStatusRepair: DropshipLiveListingStatusRepairPort;
    accountVerificationRequeue: DropshipAccountVerificationRequeuePort;
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
    return result;
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
    else this.deps.logger.warn(event);
  }
}
