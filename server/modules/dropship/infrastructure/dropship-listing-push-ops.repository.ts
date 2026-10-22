import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import { LIVE_LISTING_STATUSES } from "../domain/listing-live-status";
import type { DropshipListingPushJobStatus } from "../application/dropship-listing-push-ops-dtos";
import type {
  DropshipListingPushOpsActionResult,
  DropshipListingPushOpsJobListItem,
  DropshipListingPushOpsJobListResult,
  DropshipListingPushOpsLatestItemError,
  DropshipListingPushOpsRepository,
  DropshipListingPushOpsStatusSummary,
} from "../application/dropship-listing-push-ops-service";
import type {
  AccountVerificationRequeueResult,
  DropshipAccountVerificationRequeuePort,
  DropshipRecoveryRowFailure,
  DropshipStockLinkRequeuePort,
  RequeuedAccountVerificationJob,
  StockLinkRequeueItemOutcome,
  StockLinkRequeueResult,
  StockLinkRequeuedJob,
} from "../application/dropship-listing-push-recovery-service";
import {
  AUTOMATIC_REQUEUE_ACTOR,
  AUTOMATIC_REQUEUE_CODES,
  AUTOMATIC_RESEND_REVIEW_MARK_LIMIT,
  AUTOMATIC_RESEND_STORE_LIMIT,
  STOCK_LINK_AWARE_FAILURE_FIELD,
  STOCK_LINK_RESEND_CODE,
  automaticRequeueCap,
  automaticRequeuePolicyRows,
} from "../domain/listing-push-automatic-requeue";
import { STOCK_LINK_RESEND_DEFERRABLE_REASONS, StockLinkResendSchedule } from "../domain/stock-link-resend-schedule";
import { classifyStockLinkFailure } from "../domain/stock-link-readiness";
import { readDropshipListingStockSelection } from "./dropship-stock-publication-selection.reader";
import {
  readDropshipEbayStockDestination,
  type DropshipEbayStockDestination,
} from "../../inventory-planning/quantity-publication";
import { MARKETPLACE_PROVIDER_IDENTITY_SCHEME } from "../../marketplace-listings/domain/listing-registration-plan";
import {
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE,
} from "../../../../shared/dropship/ebay-publication-account";
import { classifyRecoveryError, recoveryErrorCode, recoveryErrorMessage } from "./dropship-listing-recovery-errors";

interface ListingPushJobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  status: DropshipListingPushJobStatus;
  job_type: string;
  requested_scope: Record<string, unknown> | null;
  requested_by: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  member_id: string;
  business_name: string | null;
  email: string | null;
  vendor_status: string;
  entitlement_status: string;
  store_platform: string;
  store_status: string;
  setup_status: string;
  external_display_name: string | null;
  shop_domain: string | null;
  item_total: string | number;
  item_queued: string | number;
  item_processing: string | number;
  item_completed: string | number;
  item_failed: string | number;
  item_blocked: string | number;
  item_cancelled: string | number;
  latest_error_item_id: number | null;
  latest_error_product_variant_id: number | null;
  latest_error_status: string | null;
  latest_error_code: string | null;
  latest_error_message: string | null;
  latest_error_updated_at: Date | null;
  total_count: string | number;
}

interface StatusCountRow {
  status: DropshipListingPushJobStatus;
  count: string | number;
}

interface ListingPushActionJobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  status: DropshipListingPushJobStatus;
  updated_at: Date;
  completed_at: Date | null;
}

interface RequeuedListingPushItemRow {
  id: number;
  listing_id: number | null;
}

const DEFAULT_LISTING_PUSH_OPS_STALE_PROCESSING_MINUTES = 30;

/** The store account's Card Shellz stock destination, read through inventory's published interface. */
export type DropshipStockDestinationReader = (input: { storeConnectionId: number; accountId: string }) => Promise<DropshipEbayStockDestination>;

export class PgDropshipListingPushOpsRepository implements DropshipListingPushOpsRepository, DropshipAccountVerificationRequeuePort,
  DropshipStockLinkRequeuePort {
  constructor(
    private readonly dbPool: Pool = defaultPool,
    private readonly stockDestination: DropshipStockDestinationReader = (input) => readDropshipEbayStockDestination(dbPool, input),
    /** When the one-time re-send reads a store's destination or a listing's selection again (explicit, in process). */
    private readonly resendSchedule: StockLinkResendSchedule = new StockLinkResendSchedule(),
  ) {}

  /**
   * Automatic re-queue for the stock link (plan F2 2.10, owner decision Q4 = YES),
   * run by the push sweep's recovery under its advisory lock.
   *
   * Selected, and re-checked under the job and item locks, only when every one
   * of these holds (the same guards as the account-check recovery above, so
   * nothing the vendor queued since is overridden and no re-queue is spent on a
   * push the worker would block):
   * - the item failed with a code of AUTOMATIC_REQUEUE_POLICY, fewer times than
   *   its cap, and its code's wait since the failure has passed;
   * - for every code but the Q4 one, the failure was recorded by the worker that
   *   links stock first (STOCK_LINK_AWARE_FAILURE_FIELD): an older failure with the
   *   same code is never re-queued, whatever its age (review V2-1);
   * - it carries no automaticRequeue state mark (exhausted, skipped, review);
   * - it is the newest push item for its listing and store variant, its preview
   *   hash is still the listing's, and the listing has not ended;
   * - the store is a connected, launch-ready, provider-verified eBay store and
   *   the vendor may list;
   * - for the Q4 code only: the failure was recorded before the automatic stock
   *   link existed (no STOCK_LINK_AWARE_FAILURE_FIELD marker: the owner's "before
   *   this deploys", review MC-3), the store's listing configuration is active live
   *   + Card Shellz-managed quantity, the store account has exactly one live Card
   *   Shellz stock destination (inventory's published destination read, fresh in
   *   this pass) and the listing is still selected (Dropship's stock selection
   *   decides `publish`). A Q4 item whose listing is no longer selected is marked
   *   skipped once and never re-sent; one that is only paused, or whose store mode
   *   was switched off, is looked at again later (review CF-2).
   * A re-queue moves the item and its job back to queued, writes the marker
   * (count + 1) and lastRetryRequest, keeps a live listing's status (the shared
   * markRequeuedListingsQueued), and writes one audit row per item, all in one
   * transaction. An item that failed again at its cap is marked exhausted once,
   * with an audit row, and reported for an ERROR line.
   */
  async requeueAutomaticStockLinkFailures(input: { now: Date; workerId: string; limit: number }): Promise<StockLinkRequeueResult> {
    const result: StockLinkRequeueResult = { requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] };
    // Listings looked at a moment ago and found only temporarily ineligible: not
    // read again yet, and kept out of this pass's LIMIT (review CF-2).
    const deferredItemIds = this.resendSchedule.deferredItemIds(input.now);
    const { live: liveStores, failed: destinationFailures } = await this.storesWithLiveStockDestination(input, deferredItemIds);
    result.failed.push(...destinationFailures);
    const candidates = await this.dbPool.query<{ job_id: number }>(
      stockLinkRequeueQuery("due", { now: input.now, liveStores, excludeItemIds: deferredItemIds, limit: input.limit }));
    for (const jobId of [...new Set(candidates.rows.map((row) => row.job_id))]) {
      try {
        const outcome = await this.requeueStockLinkJob(jobId, liveStores, deferredItemIds, input);
        if (outcome.requeued) result.requeued.push(outcome.requeued);
        result.skipped.push(...outcome.skipped);
        result.deferred.push(...outcome.deferred);
        result.failed.push(...outcome.failed);
      } catch (error) {
        result.failed.push(await this.recordStockLinkRequeueFailure(jobId, error, input));
      }
    }
    // Failed again after the code's last automatic re-queue: marked once, a human looks.
    const exhausted = await this.dbPool.query<StockLinkRequeueItemRow>(
      stockLinkRequeueQuery("at_cap", { now: input.now, liveStores, limit: input.limit }));
    for (const jobId of [...new Set(exhausted.rows.map((row) => row.job_id))]) {
      try {
        result.exhausted.push(...await this.markStockLinkItems(jobId, "at_cap", {
          state: "exhausted", code: "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_EXHAUSTED",
          message: "Failed again after its last automatic re-queue; it is not queued again automatically.",
          eventType: "listing_push_item_auto_requeue_exhausted", severity: "error",
        }, input));
      } catch (error) {
        result.failed.push(await this.recordStockLinkRequeueFailure(jobId, error, input));
      }
    }
    return result;
  }

  /**
   * Store ids whose account has exactly one live, not held, source-ready Card
   * Shellz stock destination, among stores with an open Q4 re-send (reviews MC-2,
   * CF-6):
   * - the stores come from the same guarded selection as the re-send itself
   *   (stockLinkRequeueQuery "resend_waiting"), so an item that can never be re-sent
   *   (superseded by a newer push, its listing ended or re-previewed, its store or
   *   vendor not eligible, recorded after the automatic stock link existed) never
   *   causes a read; they are taken oldest re-send first, bounded per pass;
   * - one fresh read per store. A store found not live, or whose read just failed
   *   for a passing reason, is not read again for a while (StockLinkResendSchedule)
   *   and is excluded in SQL meanwhile, so it frees its place in the LIMIT;
   * - a read failure is classified (classifyStockLinkFailure, the same taxonomy as
   *   the link): a passing one is a transient row failure (WARN once, DEBUG while it
   *   repeats); any other one fails the same way on every pass, so that store's
   *   open re-sends are marked requires_review with their audit rows and never
   *   read again (never retry a permanent error).
   */
  private async storesWithLiveStockDestination(
    input: { now: Date; workerId: string },
    deferredItemIds: readonly number[],
  ): Promise<{ live: number[]; failed: DropshipRecoveryRowFailure[] }> {
    const stores = await this.dbPool.query<{ store_connection_id: number; external_account_id: string }>(
      stockLinkResendStoresQuery({ now: input.now, excludeItemIds: deferredItemIds,
        excludeStoreIds: this.resendSchedule.waitingStoreIds(input.now), limit: AUTOMATIC_RESEND_STORE_LIMIT }));
    const live: number[] = [];
    const failed: DropshipRecoveryRowFailure[] = [];
    for (const store of stores.rows) {
      let destination: DropshipEbayStockDestination;
      try {
        destination = await this.stockDestination({ storeConnectionId: store.store_connection_id, accountId: store.external_account_id });
      } catch (error) {
        failed.push(await this.recordDestinationReadFailure(store.store_connection_id, error, input));
        continue;
      }
      if (destination.status === "live") {
        this.resendSchedule.recordDestinationLive(store.store_connection_id);
        live.push(store.store_connection_id);
      } else {
        // Waits for Card Shellz to turn the destination on (owner Q1); the ops-health
        // issues name the store meanwhile, so nothing is logged per pass here.
        this.resendSchedule.recordDestinationNotLive(store.store_connection_id, input.now);
      }
    }
    return { live, failed };
  }

  private async recordDestinationReadFailure(
    storeConnectionId: number,
    error: unknown,
    input: { now: Date; workerId: string },
  ): Promise<DropshipRecoveryRowFailure> {
    const failure: DropshipRecoveryRowFailure = {
      entity: "dropship_store_connection", entityId: storeConnectionId, code: recoveryErrorCode(error),
      message: `The stock destination could not be read for the one-time re-send: ${recoveryErrorMessage(error)}`,
      classification: "transient", markedForReview: false,
    };
    if (classifyStockLinkFailure(error).kind === "transient") {
      // Changes no row and never re-sends without the proof; the store waits longer after each failure in a row.
      const { repeated } = this.resendSchedule.recordDestinationReadFailure(storeConnectionId, input.now);
      return repeated ? { ...failure, repeated: true } : failure;
    }
    failure.classification = "permanent";
    try {
      const marked = await this.markStoreResendsForReview(storeConnectionId, {
        state: "requires_review", code: "DROPSHIP_STOCK_LINK_RESEND_DESTINATION_UNREADABLE", message: failure.message,
        eventType: "listing_push_item_auto_requeue_review_required", severity: "error",
      }, input);
      failure.markedForReview = marked > 0;
      this.resendSchedule.forgetStore(storeConnectionId);
    } catch (markError) {
      failure.message = `${failure.message} (review mark failed: ${recoveryErrorMessage(markError)})`;
      // Not marked: the store is read again only after the backoff, not on every pass.
      this.resendSchedule.recordDestinationReadFailure(storeConnectionId, input.now);
    }
    return failure;
  }

  /** Marks a store's open one-time re-sends (bounded per pass) requires_review, one transaction per job, each with its audit row. */
  private async markStoreResendsForReview(
    storeConnectionId: number,
    mark: StockLinkItemMark,
    input: { now: Date; workerId: string },
  ): Promise<number> {
    const open = await this.dbPool.query<{ job_id: number }>(stockLinkRequeueQuery("resend_waiting", {
      now: input.now, storeConnectionId, limit: AUTOMATIC_RESEND_REVIEW_MARK_LIMIT }));
    let marked = 0;
    for (const jobId of [...new Set(open.rows.map((row) => row.job_id))]) {
      marked += (await this.markStockLinkItems(jobId, "resend_waiting", mark, input, storeConnectionId)).length;
    }
    return marked;
  }

  private async requeueStockLinkJob(
    jobId: number,
    liveStores: readonly number[],
    deferredItemIds: readonly number[],
    input: { now: Date; workerId: string },
  ): Promise<{ requeued: StockLinkRequeuedJob | null; skipped: StockLinkRequeueItemOutcome[]; deferred: StockLinkRequeueItemOutcome[];
    failed: DropshipRecoveryRowFailure[] }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<ListingPushActionJobRow>(
        `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at
         FROM dropship.dropship_listing_push_jobs
         WHERE id = $1 AND status = 'failed'
         FOR UPDATE SKIP LOCKED`,
        [jobId],
      );
      const existing = job.rows[0];
      if (!existing) {
        await client.query("COMMIT");
        return { requeued: null, skipped: [], deferred: [], failed: [] };
      }
      // Re-select under the job lock, and lock the items it names.
      const items = await client.query<StockLinkRequeueItemRow>(
        stockLinkRequeueQuery("due", { now: input.now, liveStores, excludeItemIds: deferredItemIds, jobId, lockItems: true }));
      const eligible: StockLinkRequeueItemRow[] = [];
      const skipped: StockLinkRequeueItemOutcome[] = [];
      const deferred: StockLinkRequeueItemOutcome[] = [];
      const failed: DropshipRecoveryRowFailure[] = [];
      for (const item of items.rows) {
        if (item.error_code !== STOCK_LINK_RESEND_CODE) {
          eligible.push(item);
          continue;
        }
        // Q4: re-send only a listing the vendor's stock selection still publishes.
        let selection: Awaited<ReturnType<typeof readDropshipListingStockSelection>>;
        try {
          selection = await readDropshipListingStockSelection(client, {
            storeConnectionId: existing.store_connection_id, productId: item.product_id,
            productVariantIds: [item.product_variant_id], now: input.now,
          });
        } catch (error) {
          // A database error aborts this transaction: the whole job is classified by
          // the caller. Anything else (an invalid or ambiguous selection) repeats on
          // every pass, so only this item is taken out of the re-send, for review.
          if (isSqlStateError(error)) throw error;
          const message = `The stock selection could not be read for the one-time re-send: ${recoveryErrorMessage(error)}`;
          await markStockLinkItemState(client, existing, item, {
            state: "requires_review", code: "DROPSHIP_STOCK_LINK_RESEND_SELECTION_FAILED", message,
            eventType: "listing_push_item_auto_requeue_review_required", severity: "error",
          }, input);
          failed.push({ entity: "dropship_listing_push_job", entityId: jobId, code: "DROPSHIP_STOCK_LINK_RESEND_SELECTION_FAILED",
            message, classification: "permanent", markedForReview: true });
          continue;
        }
        const decision = selection.variants.find((variant) => variant.productVariantId === item.product_variant_id);
        if (decision?.action === "publish") {
          eligible.push(item);
          continue;
        }
        const reason = decision ? `${decision.action}:${decision.reason}` : "no_selection_decision";
        if (decision && STOCK_LINK_RESEND_DEFERRABLE_REASONS.has(decision.reason)) {
          // Only paused, or the store mode was switched off for now: no mark, no
          // audit row (nothing changed); looked at again later (review CF-2).
          this.resendSchedule.deferItem(item.id, input.now);
          deferred.push(itemOutcome(existing, item, reason));
          continue;
        }
        await markStockLinkItemState(client, existing, item, {
          state: "skipped", code: "DROPSHIP_LISTING_PUSH_STOCK_LINK_RESEND_SKIPPED",
          message: "Not sent again automatically: the listing is no longer selected for Card Shellz stock.", reason,
          eventType: "listing_push_item_auto_resend_skipped", severity: "info",
        }, input);
        skipped.push(itemOutcome(existing, item, reason));
      }
      if (eligible.length === 0) {
        await client.query("COMMIT");
        return { requeued: null, skipped, deferred, failed };
      }
      const idempotencyKey = `dropship-listing-push:stock-link-requeue:job:${jobId}:at:${input.now.toISOString()}`;
      const reason = "Queued again automatically by the stock link recovery.";
      const markers = eligible.map((item) => JSON.stringify({
        count: item.requeue_count + 1,
        lastCode: item.error_code,
        lastMessage: item.error_message,
        at: input.now.toISOString(),
        workerId: input.workerId,
        idempotencyKey,
        resend: item.error_code === STOCK_LINK_RESEND_CODE,
      }));
      const requeued = await client.query<RequeuedListingPushItemRow>(
        `UPDATE dropship.dropship_listing_push_job_items AS i
         SET status = 'queued',
             error_code = NULL,
             error_message = NULL,
             result = COALESCE(i.result, '{}'::jsonb) || $3::jsonb || jsonb_build_object('automaticRequeue', m.marker::jsonb),
             updated_at = $5
         FROM unnest($2::int[], $4::text[]) AS m(id, marker)
         WHERE i.job_id = $1 AND i.id = m.id AND i.status = 'failed'
         RETURNING i.id, i.listing_id`,
        [
          jobId,
          eligible.map((item) => item.id),
          retryRequestPayload({ idempotencyKey, actor: { actorType: "system", actorId: AUTOMATIC_REQUEUE_ACTOR }, reason, now: input.now }),
          markers,
          input.now,
        ],
      );
      if (requeued.rows.length !== eligible.length) {
        throw new DropshipError("DROPSHIP_LISTING_PUSH_RECOVERY_ITEM_CHANGED",
          "A locked listing push item changed before it could be queued again.", { jobId, classification: "transient" });
      }
      const listingIds = uniquePositiveIntegers(requeued.rows.map((row) => row.listing_id));
      // Review V2-4: the vendor listing's status before and after the shared helper
      // (markRequeuedListingsQueued, unchanged) goes on each item's audit row. Read
      // under the row locks the helper's UPDATE takes anyway, in this transaction.
      const listingBefore = await readListingStatusesForUpdate(client, listingIds);
      await markRequeuedListingsQueued(client, { listingIds, now: input.now, jobId, idempotencyKey });
      const listingAfter = await readListingStatusesForUpdate(client, listingIds);
      const updated = await client.query<ListingPushActionJobRow>(
        `UPDATE dropship.dropship_listing_push_jobs
         SET status = 'queued',
             error_message = NULL,
             completed_at = NULL,
             updated_at = $2
         WHERE id = $1 AND status = 'failed'
         RETURNING id, vendor_id, store_connection_id, status, updated_at, completed_at`,
        [jobId, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship listing push job stock link requeue did not return a row.");
      for (const item of eligible) {
        await recordListingPushItemAuditEvent(client, {
          job: row, itemId: item.id, eventType: "listing_push_item_auto_requeued", severity: "info", occurredAt: input.now,
          payload: {
            jobId, listingId: item.listing_id, productVariantId: item.product_variant_id, idempotencyKey,
            reason, recovery: STOCK_LINK_RECOVERY, resend: item.error_code === STOCK_LINK_RESEND_CODE,
            before: { itemStatus: "failed", jobStatus: existing.status, errorCode: item.error_code, automaticRequeues: item.requeue_count,
              listingStatus: item.listing_id === null ? null : listingBefore.get(item.listing_id) ?? null },
            after: { itemStatus: "queued", jobStatus: row.status, automaticRequeues: item.requeue_count + 1,
              listingStatus: item.listing_id === null ? null : listingAfter.get(item.listing_id) ?? null },
          },
        });
      }
      await client.query("COMMIT");
      return {
        requeued: {
          jobId, vendorId: row.vendor_id, storeConnectionId: row.store_connection_id,
          itemIds: eligible.map((item) => item.id), listingIds,
          items: eligible.map((item) => ({ itemId: item.id, errorCode: item.error_code, attempt: item.requeue_count + 1 })),
        },
        skipped,
        deferred,
        failed,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Marks the job's matching items (exhausted or requires_review) with their audit rows in one transaction. */
  private async markStockLinkItems(
    jobId: number,
    selection: "at_cap" | "open" | "resend_waiting",
    mark: StockLinkItemMark,
    input: { now: Date; workerId: string },
    storeConnectionId?: number,
  ): Promise<StockLinkRequeueItemOutcome[]> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<ListingPushActionJobRow>(
        `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at
         FROM dropship.dropship_listing_push_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [jobId],
      );
      const existing = job.rows[0];
      if (!existing) {
        await client.query("COMMIT");
        return [];
      }
      const items = await client.query<StockLinkRequeueItemRow>(
        stockLinkRequeueQuery(selection, { now: input.now, liveStores: [], jobId, storeConnectionId, lockItems: true }));
      const outcomes: StockLinkRequeueItemOutcome[] = [];
      for (const item of items.rows) {
        await markStockLinkItemState(client, existing, item, mark, input);
        outcomes.push(itemOutcome(existing, item, mark.reason));
      }
      await client.query("COMMIT");
      return outcomes;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Transient: left for the next pass. Permanent or fatal: the job's open items
   * (a re-queue code, no state mark) are marked requires_review so they are never
   * selected again (never retry a permanent error); the mark carries its own audit row.
   */
  private async recordStockLinkRequeueFailure(
    jobId: number,
    error: unknown,
    input: { now: Date; workerId: string },
  ): Promise<DropshipRecoveryRowFailure> {
    const classification = classifyRecoveryError(error);
    const failure: DropshipRecoveryRowFailure = {
      entity: "dropship_listing_push_job", entityId: jobId, code: recoveryErrorCode(error),
      message: recoveryErrorMessage(error), classification, markedForReview: false,
    };
    if (classification !== "permanent") return failure;
    try {
      const marked = await this.markStockLinkItems(jobId, "open", {
        state: "requires_review", code: failure.code, message: failure.message,
        eventType: "listing_push_item_auto_requeue_review_required", severity: "error",
      }, input);
      failure.markedForReview = marked.length > 0;
    } catch (markError) {
      failure.message = `${failure.message} (review mark failed: ${recoveryErrorMessage(markError)})`;
    }
    return failure;
  }

  /**
   * Automatic requeue of pushes refused only because the store's eBay
   * identity was not verified, once it is (BUILD-NOTES part 1: the reader
   * compared the stored identity scheme with a value no writer stores, so
   * every update of a live listing failed with the account check's message
   * and retryable false, which retryJob refuses). Two refusals qualify:
   * the push-time reader's account check (exactly its message: the
   * environment check shares the code and is a real refusal) and the stock
   * gate's identity check (PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED, raised
   * when the store has no verified account id; it is permanent for the
   * worker, so nothing else re-drives it once the vendor reconnects).
   * Selected only when every one of these still holds, re-checked under the
   * job and item locks:
   * - it is the newest push item for its listing (and for its store and
   *   variant), and its preview hash is still the listing's, so nothing the
   *   vendor queued since is overridden;
   * - the listing is live on eBay (a first push of a SKU already published on
   *   eBay is left for the vendor to queue: an automatic adoption days later
   *   could overwrite a listing they changed on eBay meanwhile);
   * - the store is verified now (provider_user_id scheme, verified_at, a
   *   non-blank account id) and launch-ready, and the vendor may list, so the
   *   requeue is not spent on a push the worker would block;
   * - the item was requeued this way fewer than
   *   MAX_ACCOUNT_REFUSAL_REQUEUES times and is not marked for review. More
   *   than once because, during a deploy, a dyno still running the old reader
   *   can take a requeued job and refuse it with the same message; the fixed
   *   reader cannot refuse a verified store that way.
   * The item gets the schemeRecovery marker (attempts, basis) and the same
   * lastRetryRequest an ops retry writes, the job goes back to queued, and the
   * same audit event as retryJob commits with them. The push-time refresh then
   * sends current data. An item refused again after the last requeue is
   * marked for review with an audit row instead.
   */
  async requeueAccountVerificationFailures(input: { now: Date; workerId: string; limit: number }): Promise<AccountVerificationRequeueResult> {
    const result: AccountVerificationRequeueResult = { requeued: [], failed: [] };
    const candidates = await this.dbPool.query<{ job_id: number }>(
      `${accountRefusalCandidateSql("below_cap", "")}
       ORDER BY i.job_id ASC
       LIMIT $6`,
      [...accountRefusalParams(), input.limit],
    );
    for (const jobId of [...new Set(candidates.rows.map((row) => row.job_id))]) {
      try {
        const requeued = await this.requeueAccountVerificationJob(jobId, input);
        if (requeued) result.requeued.push(requeued);
      } catch (error) {
        result.failed.push(await this.recordAccountVerificationRequeueFailure(jobId, error, input));
      }
    }
    // Refused again after the last automatic requeue: a human decides.
    const exhausted = await this.dbPool.query<{ job_id: number }>(
      `${accountRefusalCandidateSql("at_cap", "")}
       ORDER BY i.job_id ASC
       LIMIT $6`,
      [...accountRefusalParams(), input.limit],
    );
    for (const jobId of [...new Set(exhausted.rows.map((row) => row.job_id))]) {
      const marked = await this.markAccountRefusalsForReview(jobId, {
        code: "DROPSHIP_LISTING_PUSH_RECOVERY_REQUEUES_EXHAUSTED",
        message: `Queued again ${MAX_ACCOUNT_REFUSAL_REQUEUES} times and refused by the eBay account check each time; it is not queued again automatically.`,
        classification: "permanent",
        onlyAtCap: true,
      }, input);
      // Nothing to mark: another transaction holds the items; they are seen again next pass.
      if (marked) result.failed.push(marked);
    }
    return result;
  }

  private async requeueAccountVerificationJob(jobId: number, input: { now: Date; workerId: string }): Promise<RequeuedAccountVerificationJob | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<ListingPushActionJobRow>(
        `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at
         FROM dropship.dropship_listing_push_jobs
         WHERE id = $1 AND status = 'failed'
         FOR UPDATE SKIP LOCKED`,
        [jobId],
      );
      const existing = job.rows[0];
      if (!existing) {
        await client.query("COMMIT");
        return null;
      }
      // Re-select under the job lock, and lock the items it names.
      const items = await client.query<AccountRefusalItemRow>(
        `${accountRefusalCandidateSql("below_cap", "AND i.job_id = $6")}
         ORDER BY i.id ASC
         FOR UPDATE OF i SKIP LOCKED`,
        [...accountRefusalParams(), jobId],
      );
      if (items.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const attempt = Math.max(...items.rows.map((row) => row.attempts)) + 1;
      const baseKey = `dropship-listing-push:account-check-recovery:job:${jobId}`;
      const idempotencyKey = attempt === 1 ? baseKey : `${baseKey}:attempt:${attempt}`;
      // True in both cases the basis below tells apart: the store was verified
      // when the push failed (the earlier check misread it) or verified since.
      const reason = "Queued again automatically: this store's eBay identity is verified now.";
      const markers = items.rows.map((row) => JSON.stringify({
        attempts: row.attempts + 1,
        firstRequeuedAt: row.first_requeued_at ?? input.now.toISOString(),
        requeuedAt: input.now.toISOString(),
        workerId: input.workerId,
        idempotencyKey,
        previousErrorCode: row.error_code,
        previousErrorMessage: row.error_message,
        basis: row.basis,
      }));
      const requeued = await client.query<RequeuedListingPushItemRow>(
        `UPDATE dropship.dropship_listing_push_job_items AS i
         SET status = 'queued',
             error_code = NULL,
             error_message = NULL,
             result = COALESCE(i.result, '{}'::jsonb) || $3::jsonb || jsonb_build_object('schemeRecovery', m.marker::jsonb),
             updated_at = $5
         FROM unnest($2::int[], $4::text[]) AS m(id, marker)
         WHERE i.job_id = $1 AND i.id = m.id AND i.status = 'failed'
         RETURNING i.id, i.listing_id`,
        [
          jobId,
          items.rows.map((row) => row.id),
          retryRequestPayload({ idempotencyKey, actor: { actorType: "system", actorId: input.workerId }, reason, now: input.now }),
          markers,
          input.now,
        ],
      );
      if (requeued.rows.length !== items.rows.length) {
        throw new DropshipError("DROPSHIP_LISTING_PUSH_RECOVERY_ITEM_CHANGED",
          "A locked listing push item changed before it could be queued again.", { jobId, classification: "transient" });
      }
      const listingIds = uniquePositiveIntegers(requeued.rows.map((row) => row.listing_id));
      await markRequeuedListingsQueued(client, { listingIds, now: input.now, jobId, idempotencyKey });
      const updated = await client.query<ListingPushActionJobRow>(
        `UPDATE dropship.dropship_listing_push_jobs
         SET status = 'queued',
             error_message = NULL,
             completed_at = NULL,
             updated_at = $2
         WHERE id = $1 AND status = 'failed'
         RETURNING id, vendor_id, store_connection_id, status, updated_at, completed_at`,
        [jobId, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship listing push job account check recovery did not return a row.");
      const itemIds = items.rows.map((item) => item.id);
      await recordListingPushOpsAuditEvent(client, {
        row,
        eventType: "listing_push_job_retry_requested",
        actor: { actorType: "system", actorId: input.workerId },
        severity: "info",
        payload: {
          idempotencyKey,
          previousStatus: existing.status,
          requeuedItemCount: requeued.rows.length,
          staleJobUpdatedAt: null,
          staleAfterMinutes: null,
          reason,
          recovery: ACCOUNT_REFUSAL_RECOVERY,
          itemIds,
          listingIds,
          // Per item: which check refused it, whether the store was verified
          // before that failure (then the failure was the earlier misread) or
          // only after it (a real refusal, cleared by reconnecting), and which
          // automatic requeue this is.
          items: requeuedItemOutcomes(items.rows),
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        jobId, vendorId: row.vendor_id, storeConnectionId: row.store_connection_id,
        itemIds, listingIds, idempotencyKey,
        items: requeuedItemOutcomes(items.rows),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A permanent failure marks the job's matching items for review so they are
   * never selected again (never retry a permanent error); a transient one is
   * left for the next pass.
   */
  private async recordAccountVerificationRequeueFailure(
    jobId: number,
    error: unknown,
    input: { now: Date; workerId: string },
  ): Promise<DropshipRecoveryRowFailure> {
    const classification = classifyRecoveryError(error);
    if (classification !== "permanent") {
      return {
        entity: "dropship_listing_push_job", entityId: jobId, code: recoveryErrorCode(error),
        message: recoveryErrorMessage(error), classification, markedForReview: false,
      };
    }
    const failure = { code: recoveryErrorCode(error), message: recoveryErrorMessage(error), classification };
    return await this.markAccountRefusalsForReview(jobId, { ...failure, onlyAtCap: false }, input)
      ?? { entity: "dropship_listing_push_job", entityId: jobId, ...failure, markedForReview: false };
  }

  /**
   * Marks the job's account refusals schemeRecovery.state = requires_review
   * and writes the append-only audit row in the same transaction, so the mark
   * that takes the items out of automatic recovery is on the trail with them.
   * The items' updated_at is left alone: it is the time of their last status
   * write, which the live status repair orders pushes by. Null when no item
   * was there to mark (another transaction holds them, or none match).
   */
  private async markAccountRefusalsForReview(
    jobId: number,
    failure: { code: string; message: string; classification: "transient" | "permanent"; onlyAtCap: boolean },
    input: { now: Date; workerId: string },
  ): Promise<DropshipRecoveryRowFailure | null> {
    const outcome: DropshipRecoveryRowFailure = {
      entity: "dropship_listing_push_job", entityId: jobId, code: failure.code, message: failure.message,
      classification: failure.classification, markedForReview: false,
    };
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const items = await client.query<{ id: number }>(
        `SELECT i.id FROM dropship.dropship_listing_push_job_items i
         WHERE i.job_id = $1 AND i.status = 'failed'
           AND ((i.error_code = $2 AND i.error_message = $3) OR i.error_code = $4)
           AND COALESCE(i.result -> 'schemeRecovery' ->> 'state', '') <> 'requires_review'
           AND ($5::boolean = false OR ${ACCOUNT_REFUSAL_ATTEMPTS_SQL} >= $6)
         ORDER BY i.id ASC
         FOR UPDATE SKIP LOCKED`,
        [jobId, EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE, STOCK_GATE_ACCOUNT_UNVERIFIED_CODE,
          failure.onlyAtCap, MAX_ACCOUNT_REFUSAL_REQUEUES],
      );
      const job = await client.query<ListingPushActionJobRow>(
        `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at FROM dropship.dropship_listing_push_jobs WHERE id = $1`,
        [jobId],
      );
      if (items.rows.length === 0 || !job.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const itemIds = items.rows.map((row) => row.id);
      await client.query(
        `UPDATE dropship.dropship_listing_push_job_items
         SET result = COALESCE(result, '{}'::jsonb)
           || jsonb_build_object('schemeRecovery', COALESCE(result -> 'schemeRecovery', '{}'::jsonb) || $2::jsonb)
         WHERE id = ANY($1::int[])`,
        [itemIds, JSON.stringify({ state: "requires_review", code: failure.code, message: failure.message,
          markedAt: input.now.toISOString(), workerId: input.workerId })],
      );
      await recordListingPushOpsAuditEvent(client, {
        row: job.rows[0],
        eventType: "listing_push_recovery_review_required",
        actor: { actorType: "system", actorId: input.workerId },
        severity: "error",
        payload: { requiresReview: true, jobId, itemIds, code: failure.code, message: failure.message, recovery: ACCOUNT_REFUSAL_RECOVERY },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      outcome.markedForReview = true;
      return outcome;
    } catch (markError) {
      // Reported with the failure (and logged by the caller); tried again next pass.
      await rollbackQuietly(client);
      outcome.message = `${outcome.message} (review mark failed: ${recoveryErrorMessage(markError)})`;
      return outcome;
    } finally {
      client.release();
    }
  }

  async listJobs(
    input: Parameters<DropshipListingPushOpsRepository["listJobs"]>[0],
  ): Promise<DropshipListingPushOpsJobListResult> {
    const client = await this.dbPool.connect();
    try {
      const listFilters = buildListingPushJobFilters(input, { includeStatuses: true });
      const offset = (input.page - 1) * input.limit;
      const rows = await client.query<ListingPushJobRow>(
        `${listingPushJobSelectSql()}
         ${listFilters.whereSql}
         ORDER BY j.updated_at DESC, j.id DESC
         LIMIT $${listFilters.params.length + 1}
         OFFSET $${listFilters.params.length + 2}`,
        [...listFilters.params, input.limit, offset],
      );

      const summaryFilters = buildListingPushJobFilters(input, { includeStatuses: false });
      const summary = await client.query<StatusCountRow>(
        `SELECT j.status, COUNT(*) AS count
         ${listingPushJobBaseFromSql()}
         ${summaryFilters.whereSql}
         GROUP BY j.status
         ORDER BY j.status ASC`,
        summaryFilters.params,
      );

      return {
        items: rows.rows.map(mapListingPushJobRow),
        total: rows.rows.length > 0 ? toSafeInteger(rows.rows[0].total_count, "total_count") : 0,
        page: input.page,
        limit: input.limit,
        statuses: input.statuses,
        summary: summary.rows.map(mapStatusCountRow),
      };
    } finally {
      client.release();
    }
  }

  async retryJob(
    input: Parameters<DropshipListingPushOpsRepository["retryJob"]>[0],
  ): Promise<DropshipListingPushOpsActionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadListingPushJobForUpdate(client, input.jobId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_LISTING_PUSH_OPS_JOB_NOT_FOUND",
          "Dropship listing push job was not found.",
          { jobId: input.jobId },
        );
      }

      if (existing.status === "queued") {
        await client.query("COMMIT");
        return mapActionResult(existing, existing.status, 0, true);
      }

      const staleProcessingMinutes = listingPushOpsStaleProcessingMinutes();
      let requeuedItems: RequeuedListingPushItemRow[];
      if (existing.status === "failed") {
        requeuedItems = await requeueRetryableFailedItems(client, {
          jobId: input.jobId,
          now: input.now,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          reason: input.reason,
        });
        if (requeuedItems.length === 0) {
          throw new DropshipError(
            "DROPSHIP_LISTING_PUSH_OPS_JOB_NOT_RETRYABLE",
            "Dropship listing push job has no retryable failed items.",
            { jobId: input.jobId, status: existing.status },
          );
        }
        await markRequeuedListingsQueued(client, {
          listingIds: uniquePositiveIntegers(requeuedItems.map((row) => row.listing_id)),
          now: input.now,
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
        });
      } else if (existing.status === "processing") {
        if (!isStaleProcessingJob(existing, input.now, staleProcessingMinutes)) {
          throw new DropshipError(
            "DROPSHIP_LISTING_PUSH_OPS_STATUS_NOT_RETRYABLE",
            "Only failed or stale processing dropship listing push jobs can be retried.",
            {
              jobId: input.jobId,
              status: existing.status,
              updatedAt: existing.updated_at.toISOString(),
              staleAfterMinutes: staleProcessingMinutes,
            },
          );
        }
        requeuedItems = await requeueProcessingItems(client, {
          jobId: input.jobId,
          now: input.now,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          reason: input.reason,
          staleAfterMinutes: staleProcessingMinutes,
        });
      } else {
        throw new DropshipError(
          "DROPSHIP_LISTING_PUSH_OPS_STATUS_NOT_RETRYABLE",
          "Only failed or stale processing dropship listing push jobs can be retried.",
          { jobId: input.jobId, status: existing.status },
        );
      }

      const updated = await client.query<ListingPushActionJobRow>(
        `UPDATE dropship.dropship_listing_push_jobs
         SET status = 'queued',
             error_message = NULL,
             completed_at = NULL,
             updated_at = $2
         WHERE id = $1
         RETURNING id, vendor_id, store_connection_id, status, updated_at, completed_at`,
        [input.jobId, input.now],
      );
      const row = requiredRow(updated.rows[0], "Dropship listing push job retry did not return a row.");
      await recordListingPushOpsAuditEvent(client, {
        row,
        eventType: "listing_push_job_retry_requested",
        actor: input.actor,
        severity: existing.status === "processing" ? "warning" : "info",
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousStatus: existing.status,
          requeuedItemCount: requeuedItems.length,
          staleJobUpdatedAt: existing.status === "processing" ? existing.updated_at.toISOString() : null,
          staleAfterMinutes: existing.status === "processing" ? staleProcessingMinutes : null,
          reason: input.reason ?? null,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return mapActionResult(row, existing.status, requeuedItems.length, false);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function listingPushJobSelectSql(): string {
  return `
    SELECT
      j.id,
      j.vendor_id,
      j.store_connection_id,
      sc.platform,
      j.status,
      j.job_type,
      j.requested_scope,
      j.requested_by,
      j.idempotency_key,
      j.request_hash,
      j.error_message,
      j.created_at,
      j.updated_at,
      j.completed_at,
      v.member_id,
      v.business_name,
      v.email,
      v.status AS vendor_status,
      v.entitlement_status,
      sc.platform AS store_platform,
      sc.status AS store_status,
      sc.setup_status,
      sc.external_display_name,
      sc.shop_domain,
      COALESCE(item_counts.item_total, 0) AS item_total,
      COALESCE(item_counts.item_queued, 0) AS item_queued,
      COALESCE(item_counts.item_processing, 0) AS item_processing,
      COALESCE(item_counts.item_completed, 0) AS item_completed,
      COALESCE(item_counts.item_failed, 0) AS item_failed,
      COALESCE(item_counts.item_blocked, 0) AS item_blocked,
      COALESCE(item_counts.item_cancelled, 0) AS item_cancelled,
      latest_error.id AS latest_error_item_id,
      latest_error.product_variant_id AS latest_error_product_variant_id,
      latest_error.status AS latest_error_status,
      latest_error.error_code AS latest_error_code,
      latest_error.error_message AS latest_error_message,
      latest_error.updated_at AS latest_error_updated_at,
      COUNT(*) OVER() AS total_count
  ` + listingPushJobBaseFromSql();
}

function listingPushJobBaseFromSql(): string {
  return `
    FROM dropship.dropship_listing_push_jobs j
    INNER JOIN dropship.dropship_vendors v ON v.id = j.vendor_id
    INNER JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS item_total,
        COUNT(*) FILTER (WHERE i.status = 'queued') AS item_queued,
        COUNT(*) FILTER (WHERE i.status = 'processing') AS item_processing,
        COUNT(*) FILTER (WHERE i.status = 'completed') AS item_completed,
        COUNT(*) FILTER (WHERE i.status = 'failed') AS item_failed,
        COUNT(*) FILTER (WHERE i.status = 'blocked') AS item_blocked,
        COUNT(*) FILTER (WHERE i.status = 'cancelled') AS item_cancelled
      FROM dropship.dropship_listing_push_job_items i
      WHERE i.job_id = j.id
    ) item_counts ON true
    LEFT JOIN LATERAL (
      SELECT i.id, i.product_variant_id, i.status, i.error_code, i.error_message, i.updated_at
      FROM dropship.dropship_listing_push_job_items i
      WHERE i.job_id = j.id
        AND i.status IN ('failed', 'blocked')
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT 1
    ) latest_error ON true
  `;
}

function buildListingPushJobFilters(
  input: {
    statuses?: readonly DropshipListingPushJobStatus[];
    vendorId?: number;
    storeConnectionId?: number;
    platform?: string;
    search?: string;
  },
  options: { includeStatuses: boolean },
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.includeStatuses && input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    clauses.push(`j.status = ANY($${params.length}::text[])`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`j.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`j.store_connection_id = $${params.length}`);
  }
  if (input.platform) {
    params.push(input.platform);
    clauses.push(`sc.platform = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      j.id::text ILIKE $${params.length}
      OR j.idempotency_key ILIKE $${params.length}
      OR j.request_hash ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR v.member_id ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
      OR latest_error.error_code ILIKE $${params.length}
      OR latest_error.error_message ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapListingPushJobRow(row: ListingPushJobRow): DropshipListingPushOpsJobListItem {
  return {
    jobId: row.id,
    vendor: {
      vendorId: row.vendor_id,
      memberId: row.member_id,
      businessName: row.business_name,
      email: row.email,
      status: row.vendor_status,
      entitlementStatus: row.entitlement_status,
    },
    storeConnection: {
      storeConnectionId: row.store_connection_id,
      platform: row.store_platform,
      status: row.store_status,
      setupStatus: row.setup_status,
      externalDisplayName: row.external_display_name,
      shopDomain: row.shop_domain,
    },
    platform: row.platform,
    status: row.status,
    jobType: row.job_type,
    requestedBy: row.requested_by,
    requestedScope: row.requested_scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    itemSummary: {
      total: toSafeInteger(row.item_total, "item_total"),
      queued: toSafeInteger(row.item_queued, "item_queued"),
      processing: toSafeInteger(row.item_processing, "item_processing"),
      completed: toSafeInteger(row.item_completed, "item_completed"),
      failed: toSafeInteger(row.item_failed, "item_failed"),
      blocked: toSafeInteger(row.item_blocked, "item_blocked"),
      cancelled: toSafeInteger(row.item_cancelled, "item_cancelled"),
    },
    latestItemError: mapLatestItemError(row),
  };
}

function mapLatestItemError(row: ListingPushJobRow): DropshipListingPushOpsLatestItemError | null {
  if (
    row.latest_error_item_id === null ||
    row.latest_error_product_variant_id === null ||
    row.latest_error_status === null ||
    row.latest_error_updated_at === null
  ) {
    return null;
  }
  return {
    itemId: row.latest_error_item_id,
    productVariantId: row.latest_error_product_variant_id,
    status: row.latest_error_status,
    errorCode: row.latest_error_code,
    errorMessage: row.latest_error_message,
    updatedAt: row.latest_error_updated_at,
  };
}

function mapStatusCountRow(row: StatusCountRow): DropshipListingPushOpsStatusSummary {
  return {
    status: row.status,
    count: toSafeInteger(row.count, "status_count"),
  };
}

async function loadListingPushJobForUpdate(
  client: PoolClient,
  jobId: number,
): Promise<ListingPushActionJobRow | null> {
  const result = await client.query<ListingPushActionJobRow>(
    `SELECT id, vendor_id, store_connection_id, status, updated_at, completed_at
     FROM dropship.dropship_listing_push_jobs
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function requeueRetryableFailedItems(
  client: PoolClient,
  input: {
    jobId: number;
    now: Date;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    reason?: string;
  },
): Promise<RequeuedListingPushItemRow[]> {
  // A refusal the worker marked requiresReview (Card Shellz has to finish
  // stock setup for the listing: dropship-listing-push-worker-service
  // classifyListingPushError) is permanent: never re-queued by this path,
  // including by the stock catch-up, which retries as the system. Once the
  // setup is done, an admin's retry is how it is re-driven (the dead-letter
  // redrive). The one exception is owner decision Q4 (Fix PR 2a-2):
  // requeueAutomaticStockLinkFailures re-sends a PUBLICATION_LISTING_TARGET_UNMAPPED
  // item once, behind its own marker, live-destination and selection checks.
  const result = await client.query<RequeuedListingPushItemRow>(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = 'queued',
         error_code = NULL,
         error_message = NULL,
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE job_id = $1
       AND status = 'failed'
       AND (
         COALESCE((result->'push'->>'retryable')::boolean, true) = true
         OR ($4::boolean AND COALESCE(result->'push'->'context'->>'requiresReview', '') = 'true')
       )
     RETURNING id, listing_id`,
    [
      input.jobId,
      retryRequestPayload(input),
      input.now,
      input.actor.actorType === "admin",
    ],
  );
  return result.rows;
}

async function requeueProcessingItems(
  client: PoolClient,
  input: {
    jobId: number;
    now: Date;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    reason?: string;
    staleAfterMinutes: number;
  },
): Promise<RequeuedListingPushItemRow[]> {
  const result = await client.query<RequeuedListingPushItemRow>(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = 'queued',
         error_code = NULL,
         error_message = NULL,
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE job_id = $1
       AND status = 'processing'
     RETURNING id, listing_id`,
    [
      input.jobId,
      retryRequestPayload(input),
      input.now,
    ],
  );
  return result.rows;
}

async function markRequeuedListingsQueued(
  client: PoolClient,
  input: {
    listingIds: number[];
    now: Date;
    jobId: number;
    idempotencyKey: string;
  },
): Promise<void> {
  if (input.listingIds.length === 0) {
    return;
  }
  // A retried push changes nothing buyers see until it completes, so a
  // listing live on its marketplace keeps its status and keeps taking orders
  // (domain/listing-live-status); a listing never published shows as queued.
  await client.query(
    `UPDATE dropship.dropship_vendor_listings
     SET status = CASE
           WHEN NULLIF(BTRIM(external_listing_id), '') IS NOT NULL AND status = ANY($4::text[])
           THEN status
           ELSE 'queued'
         END,
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE id = ANY($1::int[])`,
    [
      input.listingIds,
      JSON.stringify({
        lastPushRetry: {
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          requestedAt: input.now.toISOString(),
        },
      }),
      input.now,
      [...LIVE_LISTING_STATUSES],
    ],
  );
}

/** The vendor listings' statuses, locked FOR UPDATE in the caller's transaction (an empty map for no ids). */
async function readListingStatusesForUpdate(client: PoolClient, listingIds: readonly number[]): Promise<Map<number, string>> {
  if (listingIds.length === 0) return new Map();
  const rows = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM dropship.dropship_vendor_listings WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [[...listingIds]],
  );
  return new Map(rows.rows.map((row) => [row.id, row.status]));
}

async function recordListingPushOpsAuditEvent(
  client: PoolClient,
  input: {
    row: ListingPushActionJobRow;
    eventType: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_push_job', $3, $4,
             $5, $6, $7, $8::jsonb, $9)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.severity,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

/** The recovery name on the audit rows of requeueAutomaticStockLinkFailures. */
const STOCK_LINK_RECOVERY = "dropship_stock_link";

/** Automatic re-queues an item already had: none without a marker, its count otherwise. A marker
 * this code cannot read counts as far past every cap, so it is never re-queued (fail closed). */
const STOCK_LINK_REQUEUE_COUNT_SQL = `(CASE
    WHEN COALESCE(i.result -> 'automaticRequeue' ->> 'count', '') ~ '^[0-9]{1,4}$' THEN (i.result -> 'automaticRequeue' ->> 'count')::int
    WHEN COALESCE(i.result, '{}'::jsonb) ? 'automaticRequeue' THEN 99999
    ELSE 0
  END)`;

interface StockLinkRequeueItemRow {
  id: number;
  job_id: number;
  listing_id: number | null;
  product_variant_id: number;
  product_id: number;
  error_code: string;
  error_message: string | null;
  requeue_count: number;
}

interface StockLinkItemMark {
  state: "exhausted" | "skipped" | "requires_review";
  code: string;
  message: string;
  reason?: string;
  eventType: string;
  severity: "info" | "warning" | "error";
}

type StockLinkSelection = "due" | "at_cap" | "open" | "resend_waiting" | "pending";

interface StockLinkSelectionInput {
  now: Date;
  /** Stores whose destination this pass proved live (the Q4 code's `due` items need one). */
  liveStores?: readonly number[];
  jobId?: number;
  storeConnectionId?: number;
  /** Items postponed by the resend schedule: never selected while postponed, so they take no place in a LIMIT. */
  excludeItemIds?: readonly number[];
  /** Stores whose destination is not read in this pass (resend_waiting store list only). */
  excludeStoreIds?: readonly number[];
  limit?: number;
  lockItems?: boolean;
}

/**
 * Items the stock link re-queue may act on, as one parameterized statement:
 * - `due`: a policy row exists for the item's code and re-queue count and its
 *   wait since the failure has passed; a Q4 item also needs the Q4 conditions
 *   below and its store in `liveStores` (a live Card Shellz stock destination);
 * - `at_cap`: the count reached the code's cap (it failed again after the last
 *   allowed re-queue): to be marked exhausted;
 * - `open`: any item with a re-queue code and no state mark (the failure mark);
 * - `resend_waiting`: a Q4 item that has not been re-sent and meets the Q4
 *   conditions, whatever its store's destination: the stores the pre-pass reads
 *   (stockLinkResendStoresQuery), or one store's items to mark for review;
 * - `pending` (review V2-2): a non-Q4 item `due` will select once its wait has
 *   passed (a policy row for its code and count), so the vendor's email and portal
 *   words say "automatically" only when it is true (readAutomaticRequeuePendingItemIds).
 * The Q4 conditions (owner decision Q4, review MC-3): the failure was recorded
 * before the automatic stock link existed (no STOCK_LINK_AWARE_FAILURE_FIELD in
 * result.push.context) and the store's listing configuration is active live +
 * Card Shellz-managed quantity (the only mode whose selection can say `publish`).
 * Every other policy code is owned only when the failure was recorded after it
 * (STOCK_LINK_AWARE_FAILURE_FIELD present, review V2-1): an older failure with the
 * same code is never re-queued, marked or promised, whatever its age.
 * Every mode keeps the same safety guards (newest item, unchanged preview, listing
 * not ended, eligible store and vendor). Every placeholder is referenced, so the
 * server can type each one.
 */
function stockLinkCandidateSql(mode: StockLinkSelection, input: StockLinkSelectionInput, param: (value: unknown, cast: string) => string): string {
  const caps = param(JSON.stringify(Object.fromEntries(AUTOMATIC_REQUEUE_CODES.map((code) => [code, automaticRequeueCap(code)]))), "jsonb");
  const scheme = param(MARKETPLACE_PROVIDER_IDENTITY_SCHEME, "text");
  const resendCode = param(STOCK_LINK_RESEND_CODE, "text");
  const recordedAfterLink = `COALESCE(i.result -> 'push' -> 'context' ->> ${param(STOCK_LINK_AWARE_FAILURE_FIELD, "text")}, '') = 'true'`;
  const resendEligible = `NOT (${recordedAfterLink})
       AND EXISTS (SELECT 1 FROM dropship.dropship_store_listing_configs lc
         WHERE lc.store_connection_id = j.store_connection_id AND lc.platform = sc.platform
           AND lc.is_active = true AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync')`;
  // Added only by the modes that use them: every placeholder must be referenced.
  const policyRowFor = (withWait: boolean) => {
    const rows = automaticRequeuePolicyRows();
    const codes = param(rows.map((row) => row.code), "text[]");
    const counts = param(rows.map((row) => row.count), "int[]");
    const delays = param(rows.map((row) => row.delayMs), "bigint[]");
    const wait = withWait
      ? `AND i.updated_at <= ${param(input.now, "timestamptz")} - policy.delay_ms * interval '1 millisecond'`
      : "";
    return `EXISTS (SELECT 1 FROM unnest(${codes}, ${counts}, ${delays}) AS policy(code, attempt_count, delay_ms)
         WHERE policy.code = i.error_code AND policy.attempt_count = ${STOCK_LINK_REQUEUE_COUNT_SQL}
           ${wait})`;
  };
  let modeFilter: string;
  if (mode === "due") {
    const due = policyRowFor(true);
    const liveStores = param([...(input.liveStores ?? [])], "int[]");
    modeFilter = `AND ${due}
       AND (i.error_code <> ${resendCode} OR (j.store_connection_id = ANY(${liveStores}) AND ${resendEligible}))`;
  } else if (mode === "pending") {
    modeFilter = `AND i.error_code <> ${resendCode} AND ${policyRowFor(false)}`;
  } else if (mode === "at_cap") {
    modeFilter = `AND ${STOCK_LINK_REQUEUE_COUNT_SQL} >= (${caps} ->> i.error_code)::int`;
  } else if (mode === "resend_waiting") {
    modeFilter = `AND i.error_code = ${resendCode} AND ${STOCK_LINK_REQUEUE_COUNT_SQL} = 0 AND ${resendEligible}`;
  } else {
    modeFilter = "";
  }
  const jobFilter = input.jobId === undefined ? "" : `AND i.job_id = ${param(input.jobId, "int")}`;
  const storeFilter = input.storeConnectionId === undefined ? "" : `AND j.store_connection_id = ${param(input.storeConnectionId, "int")}`;
  const itemExclusion = input.excludeItemIds?.length ? `AND NOT (i.id = ANY(${param([...input.excludeItemIds], "int[]")}))` : "";
  return `SELECT i.id, i.job_id, i.listing_id, i.product_variant_id, pv.product_id, i.error_code, i.error_message, i.updated_at,
            j.store_connection_id, BTRIM(sc.external_account_id) AS external_account_id,
            ${STOCK_LINK_REQUEUE_COUNT_SQL} AS requeue_count
     FROM dropship.dropship_listing_push_job_items i
     JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
     JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     JOIN catalog.product_variants pv ON pv.id = i.product_variant_id
     JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id AND sc.vendor_id = j.vendor_id
     JOIN dropship.dropship_vendors v ON v.id = j.vendor_id
     WHERE i.status = 'failed' AND i.action = 'push' AND j.job_type = 'push' AND j.status = 'failed'
       AND ${caps} ? i.error_code
       AND (i.error_code = ${resendCode} OR ${recordedAfterLink})
       AND COALESCE(i.result -> 'automaticRequeue' ->> 'state', '') = ''
       ${modeFilter}
       AND l.vendor_id = j.vendor_id AND l.store_connection_id = j.store_connection_id
       AND l.product_variant_id = i.product_variant_id AND l.status <> 'ended'
       AND i.preview_hash IS NOT NULL AND i.preview_hash = l.last_preview_hash
       AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer
         WHERE newer.listing_id = i.listing_id AND newer.id > i.id)
       AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer
         JOIN dropship.dropship_listing_push_jobs newer_job ON newer_job.id = newer.job_id
         WHERE newer_job.store_connection_id = j.store_connection_id
           AND newer.product_variant_id = i.product_variant_id AND newer.id > i.id)
       AND sc.platform = 'ebay' AND sc.status = 'connected' AND sc.setup_status = 'ready'
       AND sc.access_token_ref IS NOT NULL AND sc.refresh_token_ref IS NOT NULL
       AND sc.external_account_identity_scheme = ${scheme} AND sc.external_account_verified_at IS NOT NULL
       AND NULLIF(BTRIM(sc.external_account_id), '') IS NOT NULL
       AND v.status = 'active' AND v.entitlement_status = 'active'
       ${jobFilter}
       ${storeFilter}
       ${itemExclusion}`;
}

function stockLinkRequeueQuery(mode: StockLinkSelection, input: StockLinkSelectionInput): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const param = (value: unknown, cast: string) => { values.push(value); return `$${values.length}::${cast}`; };
  const candidates = stockLinkCandidateSql(mode, input, param);
  const tail = input.lockItems
    ? "ORDER BY i.id ASC FOR UPDATE OF i SKIP LOCKED"
    : `ORDER BY i.updated_at ASC, i.id ASC LIMIT ${param(input.limit ?? 1, "int")}`;
  return { text: `${candidates}\n     ${tail}`, values };
}

/**
 * The failed items of one job that the push sweep's automatic re-queue will queue
 * again by itself once their code's wait has passed (review V2-2): the `pending`
 * selection, so every guard of `due` applies (code below its cap, no state mark,
 * recorded after the automatic stock link, newest item, unchanged preview, listing
 * not ended, eligible store and vendor) except the wait. Read-only, one statement,
 * no lock: the answer is true when read; a guard that changes later (the store
 * reconnects, the vendor re-previews) changes it. The Q4 re-send is not included:
 * its vendor words say "queue the listing again" on purpose (review TW-2).
 */
export async function readAutomaticRequeuePendingItemIds(database: Pick<Pool, "query">, jobId: number): Promise<number[]> {
  const values: unknown[] = [];
  const param = (value: unknown, cast: string) => { values.push(value); return `$${values.length}::${cast}`; };
  const candidates = stockLinkCandidateSql("pending", { now: new Date(0), jobId }, param);
  const result = await database.query<{ id: number }>(`${candidates}\n     ORDER BY i.id ASC`, values);
  return result.rows.map((row) => row.id);
}

/**
 * The stores the Q4 pre-pass reads a destination for: those with a waiting
 * one-time re-send (the `resend_waiting` candidates, so every guard applies), not
 * postponed by the resend schedule, oldest waiting re-send first (reviews MC-2,
 * CF-6: no store is read for an item that can never be re-sent, and no store keeps
 * another out of the LIMIT for good).
 */
function stockLinkResendStoresQuery(input: StockLinkSelectionInput): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const param = (value: unknown, cast: string) => { values.push(value); return `$${values.length}::${cast}`; };
  const candidates = stockLinkCandidateSql("resend_waiting", input, param);
  const storeExclusion = input.excludeStoreIds?.length
    ? `WHERE NOT (candidates.store_connection_id = ANY(${param([...input.excludeStoreIds], "int[]")}))` : "";
  return {
    text: `SELECT candidates.store_connection_id, candidates.external_account_id
     FROM (${candidates}) candidates
     ${storeExclusion}
     GROUP BY candidates.store_connection_id, candidates.external_account_id
     ORDER BY MIN(candidates.updated_at) ASC, candidates.store_connection_id ASC
     LIMIT ${param(input.limit ?? AUTOMATIC_RESEND_STORE_LIMIT, "int")}`,
    values,
  };
}

/** A PostgreSQL error (it carries a SQLSTATE): the transaction is aborted and the caller classifies it. */
function isSqlStateError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

function itemOutcome(job: ListingPushActionJobRow, item: StockLinkRequeueItemRow, reason?: string): StockLinkRequeueItemOutcome {
  return {
    jobId: job.id, itemId: item.id, listingId: item.listing_id, vendorId: job.vendor_id,
    storeConnectionId: job.store_connection_id, productVariantId: item.product_variant_id,
    errorCode: item.error_code, count: item.requeue_count, ...(reason ? { reason } : {}),
  };
}

/**
 * Writes the item's automaticRequeue state mark and its append-only audit row in
 * the caller's transaction. The item's status and updated_at are left alone: the
 * mark only takes it out of automatic recovery.
 */
async function markStockLinkItemState(
  client: PoolClient,
  job: ListingPushActionJobRow,
  item: StockLinkRequeueItemRow,
  mark: StockLinkItemMark,
  input: { now: Date; workerId: string },
): Promise<void> {
  await client.query(
    // A marker that is not an object (a scalar, an array or JSON null: never written by
    // this code, so only a manual edit or corruption) is replaced, not appended to:
    // `||` on a non-object makes an array, whose 'state' reads NULL, so the item would
    // be selected and marked again on every pass (review V2-3).
    `UPDATE dropship.dropship_listing_push_job_items
     SET result = COALESCE(result, '{}'::jsonb)
       || jsonb_build_object('automaticRequeue',
            CASE WHEN jsonb_typeof(result -> 'automaticRequeue') = 'object' THEN result -> 'automaticRequeue' ELSE '{}'::jsonb END
            || $2::jsonb)
     WHERE id = $1`,
    [item.id, JSON.stringify({ state: mark.state, stateCode: mark.code, stateMessage: mark.message, ...(mark.reason ? { stateReason: mark.reason } : {}),
      markedAt: input.now.toISOString(), markedBy: input.workerId })],
  );
  await recordListingPushItemAuditEvent(client, {
    job, itemId: item.id, eventType: mark.eventType, severity: mark.severity, occurredAt: input.now,
    payload: {
      jobId: job.id, listingId: item.listing_id, productVariantId: item.product_variant_id, recovery: STOCK_LINK_RECOVERY,
      code: mark.code, message: mark.message, reason: mark.reason ?? null, requiresReview: mark.state !== "skipped",
      before: { itemStatus: "failed", errorCode: item.error_code, automaticRequeues: item.requeue_count, state: null },
      after: { itemStatus: "failed", errorCode: item.error_code, automaticRequeues: item.requeue_count, state: mark.state },
    },
  });
}

/** One append-only audit row per push item (actor: the automatic re-queue). */
async function recordListingPushItemAuditEvent(
  client: PoolClient,
  input: {
    job: ListingPushActionJobRow;
    itemId: number;
    eventType: string;
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_push_job_item', $3, $4, 'system', $5, $6, $7::jsonb, $8)`,
    [input.job.vendor_id, input.job.store_connection_id, String(input.itemId), input.eventType,
      AUTOMATIC_REQUEUE_ACTOR, input.severity, JSON.stringify(input.payload), input.occurredAt],
  );
}

/** The recovery name on the audit rows of requeueAccountVerificationFailures. */
const ACCOUNT_REFUSAL_RECOVERY = "ebay_account_identity_scheme";

/** The stock gate's refusal of a store with no verified eBay account id (inventory-planning quantity-publication-runtime). */
const STOCK_GATE_ACCOUNT_UNVERIFIED_CODE = "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED";

/**
 * How many times one item is queued again automatically. One is enough once
 * every dyno runs the fixed reader; the rest cover a deploy's overlap, when a
 * dyno still running the old reader can win the sweep lock and refuse the
 * requeued push the same way (HYPOTHESIS: the old dyno's sweep keeps running
 * until it is killed; nothing in the repo stops schedulers on SIGTERM).
 */
export const MAX_ACCOUNT_REFUSAL_REQUEUES = 3;

/** The automatic requeues an item has had: none without a marker, the marker's count otherwise (one when it has none). */
const ACCOUNT_REFUSAL_ATTEMPTS_SQL = `(CASE
    WHEN COALESCE(i.result -> 'schemeRecovery' ->> 'attempts', '') ~ '^[0-9]{1,4}$' THEN (i.result -> 'schemeRecovery' ->> 'attempts')::int
    WHEN COALESCE(i.result, '{}'::jsonb) ? 'schemeRecovery' THEN 1
    ELSE 0
  END)`;

interface AccountRefusalItemRow {
  id: number;
  job_id: number;
  listing_id: number;
  error_code: string;
  error_message: string | null;
  attempts: number;
  first_requeued_at: string | null;
  basis: "verified_before_failure" | "verified_after_failure";
}

function requeuedItemOutcomes(rows: readonly AccountRefusalItemRow[]): NonNullable<RequeuedAccountVerificationJob["items"]> {
  return rows.map((item) => ({ itemId: item.id, errorCode: item.error_code, basis: item.basis, attempt: item.attempts + 1 }));
}

/** $1-$5 of accountRefusalCandidateSql. */
function accountRefusalParams(): unknown[] {
  return [EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE, MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
    STOCK_GATE_ACCOUNT_UNVERIFIED_CODE, MAX_ACCOUNT_REFUSAL_REQUEUES];
}

/**
 * The failed account refusals that may be queued again (`below_cap`), or
 * that were refused again after the last automatic requeue (`at_cap`): see
 * requeueAccountVerificationFailures. $1 the reader's code, $2 its account
 * check's exact message, $3 the verified identity scheme, $4 the stock gate's
 * code, $5 the requeue cap; `extraFilter` may add a $6 condition.
 */
function accountRefusalCandidateSql(attempts: "below_cap" | "at_cap", extraFilter: string): string {
  return `SELECT i.id, i.job_id, i.listing_id, i.error_code, i.error_message,
            ${ACCOUNT_REFUSAL_ATTEMPTS_SQL} AS attempts,
            i.result -> 'schemeRecovery' ->> 'firstRequeuedAt' AS first_requeued_at,
            CASE WHEN sc.external_account_verified_at <= COALESCE(
                   CASE WHEN COALESCE(i.result -> 'push' ->> 'processedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                        THEN (i.result -> 'push' ->> 'processedAt')::timestamptz END,
                   i.updated_at)
                 THEN 'verified_before_failure' ELSE 'verified_after_failure' END AS basis
     FROM dropship.dropship_listing_push_job_items i
     JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
     JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id AND sc.vendor_id = j.vendor_id
     JOIN dropship.dropship_vendors v ON v.id = j.vendor_id
     WHERE i.status = 'failed' AND i.action = 'push' AND j.job_type = 'push' AND j.status = 'failed'
       AND ((i.error_code = $1 AND i.error_message = $2) OR i.error_code = $4)
       AND COALESCE(i.result -> 'schemeRecovery' ->> 'state', '') <> 'requires_review'
       AND ${ACCOUNT_REFUSAL_ATTEMPTS_SQL} ${attempts === "below_cap" ? "<" : ">="} $5
       AND l.vendor_id = j.vendor_id AND l.store_connection_id = j.store_connection_id
       AND l.product_variant_id = i.product_variant_id
       AND NULLIF(BTRIM(l.external_listing_id), '') IS NOT NULL
       AND i.preview_hash IS NOT NULL AND i.preview_hash = l.last_preview_hash
       AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer
         WHERE newer.listing_id = i.listing_id AND newer.id > i.id)
       AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer
         JOIN dropship.dropship_listing_push_jobs newer_job ON newer_job.id = newer.job_id
         WHERE newer_job.store_connection_id = j.store_connection_id
           AND newer.product_variant_id = i.product_variant_id AND newer.id > i.id)
       AND sc.platform = 'ebay' AND sc.status = 'connected' AND sc.setup_status = 'ready'
       AND sc.access_token_ref IS NOT NULL AND sc.refresh_token_ref IS NOT NULL
       AND sc.external_account_identity_scheme = $3 AND sc.external_account_verified_at IS NOT NULL
       AND NULLIF(BTRIM(sc.external_account_id), '') IS NOT NULL
       AND v.status = 'active' AND v.entitlement_status = 'active'
       ${extraFilter}`;
}

function retryRequestPayload(input: {
  idempotencyKey: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  reason?: string;
  now: Date;
  staleAfterMinutes?: number;
}): string {
  return JSON.stringify({
    lastRetryRequest: {
      idempotencyKey: input.idempotencyKey,
      reason: input.reason ?? null,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
      requestedAt: input.now.toISOString(),
      staleAfterMinutes: input.staleAfterMinutes ?? null,
    },
  });
}

function mapActionResult(
  row: ListingPushActionJobRow,
  previousStatus: DropshipListingPushJobStatus,
  requeuedItemCount: number,
  idempotentReplay: boolean,
): DropshipListingPushOpsActionResult {
  return {
    jobId: row.id,
    previousStatus,
    status: row.status,
    requeuedItemCount,
    idempotentReplay,
    updatedAt: row.updated_at,
  };
}

function listingPushOpsStaleProcessingMinutes(): number {
  const value = Number(process.env.DROPSHIP_LISTING_PUSH_STALE_PROCESSING_MINUTES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LISTING_PUSH_OPS_STALE_PROCESSING_MINUTES;
}

function isStaleProcessingJob(
  row: Pick<ListingPushActionJobRow, "updated_at">,
  now: Date,
  staleAfterMinutes: number,
): boolean {
  return row.updated_at.getTime() <= now.getTime() - staleAfterMinutes * 60_000;
}

function uniquePositiveIntegers(values: ReadonlyArray<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => (
    typeof value === "number" && Number.isInteger(value) && value > 0
  )))];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_OPS_INTEGER_RANGE_ERROR",
      "Dropship listing push ops integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
