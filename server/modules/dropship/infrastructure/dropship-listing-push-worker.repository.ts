import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import { isDropshipStoreConnectionLaunchReady } from "../domain/store-connection";
import { LIVE_LISTING_STATUSES, listingStatusAfterCompletedPush } from "../domain/listing-live-status";
import type { DropshipStoreListingConfig } from "../application/dropship-marketplace-listing-provider";
import type {
  DropshipListingPushWorkerEligibility,
  DropshipListingPushWorkerClaim,
  DropshipListingPushWorkerItemRecord,
  DropshipListingPushWorkerJobRecord,
  DropshipListingPushPauseOutcome,
  DropshipListingPushWorkerRepository,
  DropshipListingPushWorkerResult,
} from "../application/dropship-listing-push-worker-service";
import { summarizeWorkerItems } from "../application/dropship-listing-push-worker-service";
import { LISTING_PUSH_RUN_CODES, isItemInFlightAtStop, itemTransientPauses, pushPauseBackoffMs } from "../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS } from "../domain/listing-push-run-words";
import { restoreListingsOfCancelledItems, syncRunTargetsOfItems } from "./dropship-listing-push-run-items";
import { updateMarketplaceIssueCodesWithClient } from "./dropship-marketplace-listing-sync-state.repository";
import { recordPreviousMarketplaceIdWithClient } from "./dropship-marketplace-previous-ids.repository";
import type { MarketplaceIssueCode } from "../domain/marketplace-sync-decision";

/**
 * Listing issues a completed push disproves (eBay sync-back plan v4 §5 step 7): eBay took the write, so the listing
 * is on eBay under its SKU and offer again. A dead letter (sync_requires_review) is never lifted here: only a person does.
 */
const ISSUES_CLEARED_BY_COMPLETED_PUSH: readonly MarketplaceIssueCode[] = ["ended_out_of_stock", "offer_missing", "sku_changed"];

/** The source of the listing sync events the worker writes when it puts a cancelled item's listing back (verify V7). */
const WORKER_SYNC_SOURCE = "dropship_worker";

interface JobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  status: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  vendor_status: string;
  entitlement_status: string;
  store_status: string;
  setup_status: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  /** bigint: node-postgres returns it as text. */
  run_id: string | number | null;
  consecutive_pause_count: number;
}

interface StoreListingConfigRow {
  id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  listing_mode: DropshipStoreListingConfig["listingMode"];
  inventory_mode: DropshipStoreListingConfig["inventoryMode"];
  price_mode: DropshipStoreListingConfig["priceMode"];
  marketplace_config: Record<string, unknown> | null;
  required_config_keys: unknown;
  required_product_fields: unknown;
  is_active: boolean;
}

interface JobItemRow {
  id: number;
  job_id: number;
  listing_id: number | null;
  product_variant_id: number;
  status: string;
  preview_hash: string | null;
  external_listing_id: string | null;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  listing_status: string | null;
  listing_external_listing_id: string | null;
  listing_external_offer_id: string | null;
  listing_last_preview_hash: string | null;
}

interface CountByStatusRow {
  status: string;
  count: string | number;
}

const STALE_LISTING_PUSH_PROCESSING_MINUTES = 30;

export class PgDropshipListingPushWorkerRepository implements DropshipListingPushWorkerRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async claimJob(input: {
    jobId: number;
    workerId: string;
    idempotencyKey: string;
    now: Date;
    staleProcessingMinutes?: number;
  }): Promise<DropshipListingPushWorkerClaim> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await findJobForUpdate(client, input.jobId);
      if (!job) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", {
          jobId: input.jobId,
        });
      }
      const config = await loadStoreListingConfig(client, job.store_connection_id);
      if (!config) {
        throw new DropshipError("DROPSHIP_LISTING_CONFIG_REQUIRED", "Store listing configuration is required.", {
          jobId: input.jobId,
          storeConnectionId: job.store_connection_id,
        });
      }

      if (
        job.status === "processing"
        && !isStaleProcessingJob(job, input.now, input.staleProcessingMinutes ?? STALE_LISTING_PUSH_PROCESSING_MINUTES)
      ) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_ALREADY_PROCESSING", "Dropship listing push job is already processing.", {
          jobId: input.jobId,
        });
      }

      let claimed = false;
      let currentJob = job;
      if (job.status === "processing") {
        currentJob = await recoverStaleProcessingJob(client, {
          job,
          workerId: input.workerId,
          idempotencyKey: input.idempotencyKey,
          staleAfterMinutes: input.staleProcessingMinutes ?? STALE_LISTING_PUSH_PROCESSING_MINUTES,
          now: input.now,
        });
        claimed = true;
      } else if (job.status === "queued") {
        // A paused job waits for its backoff whoever calls (verify V4): the sweep lists only due jobs, and a direct
        // caller (the stock catch-up, a staff sweep that listed the job before it paused) is told it was not claimed,
        // instead of sending again at once and counting toward the job breaker.
        const updated = await client.query<JobRow>(
          `UPDATE dropship.dropship_listing_push_jobs AS j
           SET status = 'processing',
               updated_at = $2
           WHERE j.id = $1
             AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= $2::timestamptz)
           RETURNING j.id, j.vendor_id, j.store_connection_id,
                     (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
                     j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at,
                     j.run_id, j.consecutive_pause_count,
                     (SELECT v.status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS vendor_status,
                     (SELECT v.entitlement_status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS entitlement_status,
                     (SELECT sc.status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS store_status,
                     (SELECT sc.setup_status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS setup_status,
                     (SELECT sc.access_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS access_token_ref,
                     (SELECT sc.refresh_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS refresh_token_ref`,
          [input.jobId, input.now],
        );
        if (!updated.rows[0]) {
          const items = await listJobItemsWithClient(client, input.jobId);
          await client.query("COMMIT");
          return { job: mapJobRow(job), config, eligibility: mapJobEligibility(job), items, claimed: false };
        }
        currentJob = updated.rows[0];
        claimed = true;
        await recordAuditEvent(client, {
          vendorId: currentJob.vendor_id,
          storeConnectionId: currentJob.store_connection_id,
          entityType: "dropship_listing_push_job",
          entityId: String(currentJob.id),
          eventType: "listing_push_job_claimed",
          actorId: input.workerId,
          payload: { idempotencyKey: input.idempotencyKey },
          occurredAt: input.now,
        });
      }

      const items = await listJobItemsWithClient(client, input.jobId);
      await client.query("COMMIT");
      return {
        job: mapJobRow(currentJob),
        config,
        eligibility: mapJobEligibility(currentJob),
        items,
        claimed,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markItemProcessing(input: {
    jobId: number;
    itemId: number;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // A run's chunk: the run first, shared (run, then job, then item, as a stop, a chunk record and the breaker
      // lock them). A stop either committed before this read, and the item is cancelled below, or waits for this
      // start to commit, and then finds it processing (only an item already being sent finishes, §4.6).
      const run = await client.query<{ run_id: string | number; vendor_id: number; store_connection_id: number; cancel_requested_at: Date | null }>(
        `SELECT r.id AS run_id, r.vendor_id, r.store_connection_id, r.cancel_requested_at
         FROM dropship.dropship_listing_push_runs r
         WHERE r.id = (SELECT j.run_id FROM dropship.dropship_listing_push_jobs j WHERE j.id = $1)
         FOR SHARE OF r`,
        [input.jobId],
      );
      // The job's heartbeat (the job before its items, as every writer of both does): a job whose items keep
      // starting is never taken for stale (F5). updated_at alone fires no publication trigger (0743:124).
      await client.query(
        `UPDATE dropship.dropship_listing_push_jobs
         SET updated_at = $2
         WHERE id = $1
           AND status = 'processing'`,
        [input.jobId, input.now],
      );
      const stoppedRun = run.rows[0]?.cancel_requested_at ? run.rows[0] : null;
      if (stoppedRun) {
        const cancelRequestedAt = stoppedRun.cancel_requested_at as Date;
        // The size that was being sent when the vendor stopped, whose worker died before eBay's answer was recorded:
        // stale recovery queued it after the stop. It is sent once more, never cancelled blind, so the connector adopts
        // or flags what eBay holds (review MC1). The run, then the item, as above.
        const queuedItem = await client.query<{ result: Record<string, unknown> | null }>(
          `SELECT result FROM dropship.dropship_listing_push_job_items
           WHERE job_id = $1 AND id = $2 AND status = 'queued'
           FOR UPDATE`,
          [input.jobId, input.itemId],
        );
        if (queuedItem.rows[0] && isItemInFlightAtStop(queuedItem.rows[0].result)) {
          await client.query(
            `UPDATE dropship.dropship_listing_push_job_items
             SET status = 'processing', updated_at = $3
             WHERE job_id = $1 AND id = $2 AND status = 'queued'`,
            [input.jobId, input.itemId, input.now],
          );
          await recordAuditEvent(client, {
            vendorId: stoppedRun.vendor_id,
            storeConnectionId: stoppedRun.store_connection_id,
            entityType: "dropship_listing_push_job_item",
            entityId: String(input.itemId),
            eventType: "listing_push_job_item_finishing_after_stop",
            actorId: input.workerId,
            severity: "warning",
            payload: { jobId: input.jobId, runId: toSafeId(stoppedRun.run_id, "run_id"), at: "start", reason: "in_flight_at_stop",
              cancelRequestedAt: cancelRequestedAt.toISOString(), before: "queued", after: "processing" },
            occurredAt: input.now,
          });
          await client.query("COMMIT");
          return true;
        }
        // Anything else the queue holds after the stop (a pause, a staff retry) is cancelled now, never started
        // (review MC4).
        const cancelled = await client.query(
          `UPDATE dropship.dropship_listing_push_job_items
           SET status = 'cancelled', error_code = $3, error_message = $4,
               result = COALESCE(result, '{}'::jsonb) || $5::jsonb, updated_at = $6
           WHERE job_id = $1 AND id = $2 AND status = 'queued'`,
          [input.jobId, input.itemId, LISTING_PUSH_RUN_CODES.stopped, LISTING_PUSH_RUN_WORDS.itemStopped,
            JSON.stringify({ runStop: { runId: toSafeId(stoppedRun.run_id, "run_id"), cancelledAt: input.now.toISOString() } }), input.now],
        );
        if (cancelled.rowCount === 1) {
          // Its listing goes back as it was (it never reached eBay; verify V7), and its target says cancelled now (V1).
          const restored = await restoreListingsOfCancelledItems(client, { itemIds: [input.itemId], source: WORKER_SYNC_SOURCE, now: input.now });
          await syncRunTargetsOfItems(client, { itemIds: [input.itemId] });
          await recordAuditEvent(client, {
            vendorId: stoppedRun.vendor_id,
            storeConnectionId: stoppedRun.store_connection_id,
            entityType: "dropship_listing_push_job_item",
            entityId: String(input.itemId),
            eventType: "listing_push_job_item_cancelled_after_stop",
            actorId: input.workerId,
            payload: { jobId: input.jobId, runId: toSafeId(stoppedRun.run_id, "run_id"), at: "start", before: "queued", after: "cancelled",
              restoredListing: restored[0] ?? null },
            occurredAt: input.now,
          });
        }
        await client.query("COMMIT");
        return false;
      }
      // Guarded: an item a stop cancelled, or another worker took, is never started.
      const result = await client.query(
        `UPDATE dropship.dropship_listing_push_job_items
         SET status = 'processing',
             updated_at = $3
         WHERE job_id = $1
           AND id = $2
           AND status = 'queued'`,
        [input.jobId, input.itemId, input.now],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeItem(input: Parameters<DropshipListingPushWorkerRepository["completeItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // A completed push ends the job's run of pauses (§4.5); the job before its item.
      await client.query(
        `UPDATE dropship.dropship_listing_push_jobs
         SET consecutive_pause_count = 0
         WHERE id = $1
           AND consecutive_pause_count <> 0`,
        [input.job.jobId],
      );
      await updateJobItemTerminalStatus(client, {
        itemId: input.item.itemId,
        status: "completed",
        externalListingId: input.pushResult.externalListingId,
        errorCode: null,
        errorMessage: null,
        resultPatch: {
          push: {
            status: input.pushResult.status,
            externalListingId: input.pushResult.externalListingId,
            externalOfferId: input.pushResult.externalOfferId,
            rawResult: input.pushResult.rawResult,
            pushedAt: input.now.toISOString(),
            workerId: input.workerId,
          },
        },
        now: input.now,
      });
      // The item numbers before this completion (eBay sync-back): the item, then the listing, as before.
      const listingBefore = input.item.listingId === null ? null : (await client.query<{
        external_listing_id: string | null; external_offer_id: string | null;
      }>(`SELECT external_listing_id, external_offer_id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE`,
      [input.item.listingId])).rows[0] ?? null;
      await client.query(
        `UPDATE dropship.dropship_vendor_listings
         SET status = $8,
             external_listing_id = $2,
             external_offer_id = $3,
             pushed_quantity = $4,
             vendor_retail_price_cents = $5,
             last_pushed_at = $6,
             metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb,
             updated_at = $6
         WHERE id = $1`,
        [
          input.item.listingId,
          input.pushResult.externalListingId,
          input.pushResult.externalOfferId,
          input.intent.quantity,
          input.intent.priceCents,
          input.now,
          JSON.stringify({
            lastPush: {
              jobId: input.job.jobId,
              jobItemId: input.item.itemId,
              status: input.pushResult.status,
              workerId: input.workerId,
            },
          }),
          listingStatusAfterCompletedPush(input.intent.listingMode),
        ],
      );
      if (input.item.listingId !== null) await this.recordCompletedPushOnListing(client, input, listingBefore);
      // The run's target says completed in the same transaction (verify V1), so the run's count moves now. Item, then
      // listing, then target: the order a stop keeps for the items it cancels.
      await syncRunTargetsOfItems(client, { itemIds: [input.item.itemId] });
      await recordListingSyncEvent(client, {
        listingId: requiredNumber(input.item.listingId, "Listing id is required for listing sync event."),
        eventType: "listing_push_completed",
        source: "dropship_worker",
        payload: {
          jobId: input.job.jobId,
          jobItemId: input.item.itemId,
          externalListingId: input.pushResult.externalListingId,
          externalOfferId: input.pushResult.externalOfferId,
          quantity: input.intent.quantity,
          priceCents: input.intent.priceCents,
          // What eBay took (eBay sync-back SB3): Card Shellz's baseline for the vendor-owned fields.
          ...(input.pushResult.sent ? {
            currency: input.pushResult.sent.currency, sku: input.pushResult.sent.sku,
            fulfillmentPolicyId: input.pushResult.sent.fulfillmentPolicyId, returnPolicyId: input.pushResult.sent.returnPolicyId,
            paymentPolicyId: input.pushResult.sent.paymentPolicyId,
            // Review OR-1: the fingerprints of the text this push wrote (owner rule 2's "what Card Shellz last sent").
            titleHash: input.pushResult.sent.titleHash, descriptionHash: input.pushResult.sent.descriptionHash,
          } : {}),
        },
        occurredAt: input.now,
      });
      await recordAuditEvent(client, {
        vendorId: input.job.vendorId,
        storeConnectionId: input.job.storeConnectionId,
        entityType: "dropship_listing_push_job_item",
        entityId: String(input.item.itemId),
        eventType: "listing_push_item_completed",
        actorId: input.workerId,
        payload: {
          jobId: input.job.jobId,
          listingId: input.item.listingId,
          externalListingId: input.pushResult.externalListingId,
        },
        occurredAt: input.now,
      });
      const item = await getJobItemWithClient(client, input.item.itemId);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * eBay sync-back's facts a completed push proves (plan v4 §5 step 7), in the
   * completion's transaction: the shipping policy now live, the item number
   * the listing had before (when eBay gave it a new one), the issues eBay's
   * acceptance disproves, no vendor end, and the listing due for the sweep's
   * next read. The stored intent (result.listingIntent) is never patched.
   */
  private async recordCompletedPushOnListing(client: PoolClient,
    input: Parameters<DropshipListingPushWorkerRepository["completeItem"]>[0],
    before: { external_listing_id: string | null; external_offer_id: string | null } | null): Promise<void> {
    const listingId = input.item.listingId!;
    await client.query(
      `UPDATE dropship.dropship_vendor_listings
       SET observed_fulfillment_policy_id = COALESCE($2, observed_fulfillment_policy_id),
           marketplace_ended_at = NULL,
           marketplace_sync_attempted_at = NULL
       WHERE id = $1`,
      [listingId, input.pushResult.sent?.fulfillmentPolicyId ?? null],
    );
    const previous = before?.external_listing_id?.trim() || null;
    // A staged draft records its offer id as its item number: that was never an eBay item number.
    if (previous !== null && previous !== input.pushResult.externalListingId && previous !== before?.external_offer_id) {
      await recordPreviousMarketplaceIdWithClient(client, { listingId, externalListingId: previous, reason: "republished",
        replacedAt: input.now });
    }
    await updateMarketplaceIssueCodesWithClient(client, { listingId, add: [], remove: ISSUES_CLEARED_BY_COMPLETED_PUSH, at: input.now });
  }

  /**
   * eBay sync-back's quiet stop (plan v4 §5, owner rules 5 and 7): the vendor
   * ended the listing on eBay and this item may not relist it, so nothing is
   * sent. The item is cancelled, not failed: no failure email (no notice for
   * an ended listing), and nothing re-queues it. The listing keeps the
   * status the pre-read wrote. Only an item still queued or being sent.
   */
  async skipItem(input: Parameters<DropshipListingPushWorkerRepository["skipItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const skipped = await client.query(
        `UPDATE dropship.dropship_listing_push_job_items
         SET status = 'cancelled', error_code = $2, error_message = $3,
             result = COALESCE(result, '{}'::jsonb) || $4::jsonb, updated_at = $5
         WHERE id = $1 AND status IN ('queued', 'processing')`,
        [input.item.itemId, input.code, input.message,
          JSON.stringify({ push: { status: "skipped", errorCode: input.code, errorMessage: input.message, retryable: false,
            workerId: input.workerId, processedAt: input.now.toISOString() } }),
          input.now],
      );
      if (skipped.rowCount === 1) {
        if (input.item.listingId !== null) {
          await recordListingSyncEvent(client, {
            listingId: input.item.listingId,
            eventType: "listing_push_skipped",
            source: WORKER_SYNC_SOURCE,
            payload: { jobId: input.job.jobId, jobItemId: input.item.itemId, code: input.code },
            occurredAt: input.now,
          });
        }
        await syncRunTargetsOfItems(client, { itemIds: [input.item.itemId] });
        await recordAuditEvent(client, {
          vendorId: input.job.vendorId,
          storeConnectionId: input.job.storeConnectionId,
          entityType: "dropship_listing_push_job_item",
          entityId: String(input.item.itemId),
          eventType: "listing_push_item_skipped",
          actorId: input.workerId,
          payload: { jobId: input.job.jobId, listingId: input.item.listingId, code: input.code, before: "processing", after: "cancelled" },
          occurredAt: input.now,
        });
      }
      const item = await getJobItemWithClient(client, input.item.itemId);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failItem(input: Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    return this.markItemTerminalFailure({
      ...input,
      status: "failed",
      eventType: "listing_push_item_failed",
    });
  }

  async blockItem(input: Parameters<DropshipListingPushWorkerRepository["blockItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    return this.markItemTerminalFailure({
      ...input,
      status: "blocked",
      retryable: false,
      eventType: "listing_push_item_blocked",
    });
  }

  async finalizeJob(input: {
    jobId: number;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await findJobForUpdate(client, input.jobId);
      if (!job) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", {
          jobId: input.jobId,
        });
      }
      const counts = await client.query<CountByStatusRow>(
        `SELECT status, COUNT(*) AS count
         FROM dropship.dropship_listing_push_job_items
         WHERE job_id = $1
         GROUP BY status`,
        [input.jobId],
      );
      const statusCounts = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
      const pendingCount = (statusCounts.get("queued") ?? 0) + (statusCounts.get("processing") ?? 0);
      const failedCount = (statusCounts.get("failed") ?? 0) + (statusCounts.get("blocked") ?? 0);
      const nextStatus = pendingCount > 0
        ? "processing"
        : failedCount > 0
          ? "failed"
          : "completed";
      // Decided here, not in SQL: a parameter that is both assigned to the
      // varchar status column and compared with text literals makes
      // PostgreSQL refuse the statement ("inconsistent types deduced for
      // parameter"), which left every job "processing" for good.
      const finishedAt = nextStatus === "processing" ? null : input.now;
      const errorMessage = nextStatus === "failed" ? "One or more listing push items failed or were blocked." : null;
      const updated = await client.query<JobRow>(
        `UPDATE dropship.dropship_listing_push_jobs AS j
         SET status = $2,
             completed_at = COALESCE($3::timestamptz, j.completed_at),
             updated_at = $4,
             error_message = $5
         WHERE j.id = $1
         RETURNING j.id, j.vendor_id, j.store_connection_id,
                   (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
                   j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at,
                     j.run_id, j.consecutive_pause_count,
                   (SELECT v.status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS vendor_status,
                   (SELECT v.entitlement_status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS entitlement_status,
                   (SELECT sc.status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS store_status,
                   (SELECT sc.setup_status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS setup_status,
                   (SELECT sc.access_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS access_token_ref,
                   (SELECT sc.refresh_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS refresh_token_ref`,
        [input.jobId, nextStatus, finishedAt, input.now, errorMessage],
      );
      const currentJob = mapJobRow(requiredRow(updated.rows[0], "Dropship listing push job finalize did not return a row."));
      const items = await listJobItemsWithClient(client, input.jobId);
      await recordAuditEvent(client, {
        vendorId: currentJob.vendorId,
        storeConnectionId: currentJob.storeConnectionId,
        entityType: "dropship_listing_push_job",
        entityId: String(input.jobId),
        eventType: "listing_push_job_finalized",
        actorId: input.workerId,
        payload: { status: currentJob.status, summary: summarizeWorkerItems(items) },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        job: currentJob,
        items,
        summary: summarizeWorkerItems(items),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async pauseItem(input: Parameters<DropshipListingPushWorkerRepository["pauseItem"]>[0]): Promise<DropshipListingPushPauseOutcome> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // Lock order: the run, then the job, then its item (as a stop, a chunk record and the breaker take them).
      const runId = input.job.runId ?? null;
      if (runId !== null) {
        const run = await client.query<{ cancel_requested_at: Date | null }>(
          "SELECT cancel_requested_at FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE", [runId]);
        const cancelRequestedAt = run.rows[0]?.cancel_requested_at ?? null;
        const pausedItem = cancelRequestedAt
          ? await client.query<{ result: Record<string, unknown> | null }>(
            // Read, not locked: the run is held, and the job is locked before its item below (run, job, item order).
            "SELECT result FROM dropship.dropship_listing_push_job_items WHERE id = $1 AND status = 'processing'",
            [input.item.itemId])
          : null;
        const inFlightAtStop = cancelRequestedAt !== null && pausedItem?.rows[0] !== undefined
          && isItemInFlightAtStop(pausedItem.rows[0].result);
        if (cancelRequestedAt && inFlightAtStop) {
          // The size in flight at the stop (review MC1): this answer did nothing, and the earlier try's outcome on eBay
          // is still unknown, so it waits and is sent again (the item and job breakers still bound it) instead of being
          // cancelled. The pause below takes the job, then the item.
          await recordAuditEvent(client, {
            vendorId: input.job.vendorId,
            storeConnectionId: input.job.storeConnectionId,
            entityType: "dropship_listing_push_job_item",
            entityId: String(input.item.itemId),
            eventType: "listing_push_job_item_finishing_after_stop",
            actorId: input.workerId,
            severity: "warning",
            payload: { jobId: input.job.jobId, runId, at: "pause", reason: "in_flight_at_stop", code: input.code,
              cancelRequestedAt: cancelRequestedAt.toISOString(), before: "processing", after: "queued" },
            occurredAt: input.now,
          });
        }
        if (cancelRequestedAt && !inFlightAtStop) {
          // Stopped while this item was sent, and the answer said nothing was done: cancelled, never queued again, so
          // nothing of the run is sent after the stop (§4.6 "only an item already processing finishes"; review MC4).
          const cancelled = await client.query(
            `UPDATE dropship.dropship_listing_push_job_items
             SET status = 'cancelled', error_code = $2, error_message = $3,
                 result = COALESCE(result, '{}'::jsonb) || $4::jsonb, updated_at = $5
             WHERE id = $1 AND status = 'processing'`,
            [input.item.itemId, LISTING_PUSH_RUN_CODES.stopped, LISTING_PUSH_RUN_WORDS.itemStopped,
              JSON.stringify({ runStop: { runId, cancelledAt: input.now.toISOString() },
                lastPause: { code: input.code, message: input.message, reason: input.reason, pausedAt: input.now.toISOString(),
                  workerId: input.workerId } }),
              input.now],
          );
          if (cancelled.rowCount === 1) {
            // eBay did nothing for it: its listing goes back as it was (verify V7), its target says cancelled (V1).
            const restored = await restoreListingsOfCancelledItems(client, { itemIds: [input.item.itemId], source: WORKER_SYNC_SOURCE, now: input.now });
            await syncRunTargetsOfItems(client, { itemIds: [input.item.itemId] });
            await recordAuditEvent(client, {
              vendorId: input.job.vendorId,
              storeConnectionId: input.job.storeConnectionId,
              entityType: "dropship_listing_push_job_item",
              entityId: String(input.item.itemId),
              eventType: "listing_push_job_item_cancelled_after_stop",
              actorId: input.workerId,
              payload: { jobId: input.job.jobId, runId, at: "pause", code: input.code, reason: input.reason,
                before: "processing", after: "cancelled", restoredListing: restored[0] ?? null },
              occurredAt: input.now,
            });
          }
          await client.query("COMMIT");
          return { outcome: "stopped" };
        }
      }
      const locked = await findJobForUpdate(client, input.job.jobId);
      if (!locked) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", { jobId: input.job.jobId });
      }
      const consecutivePauseCount = (locked.consecutive_pause_count ?? 0) + 1;
      const nextAttemptAt = new Date(input.now.getTime() + pushPauseBackoffMs(consecutivePauseCount));
      // The job before its item. Back to queued with a backoff: the sweep claims it again once it is due.
      const updated = await client.query<JobRow>(
        `UPDATE dropship.dropship_listing_push_jobs AS j
         SET status = 'queued',
             consecutive_pause_count = $2,
             next_attempt_at = $3,
             updated_at = $4
         WHERE j.id = $1
           AND j.status = 'processing'
         RETURNING j.id, j.vendor_id, j.store_connection_id,
                   (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
                   j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at,
                   j.run_id, j.consecutive_pause_count,
                   (SELECT v.status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS vendor_status,
                   (SELECT v.entitlement_status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS entitlement_status,
                   (SELECT sc.status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS store_status,
                   (SELECT sc.setup_status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS setup_status,
                   (SELECT sc.access_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS access_token_ref,
                   (SELECT sc.refresh_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS refresh_token_ref`,
        [input.job.jobId, consecutivePauseCount, nextAttemptAt, input.now],
      );
      const job = requiredRow(updated.rows[0], "Paused listing push job is no longer processing.");
      const pauses = itemTransientPauses(input.item.result) + 1;
      await client.query(
        `UPDATE dropship.dropship_listing_push_job_items
         SET status = 'queued',
             result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
             updated_at = $3
         WHERE id = $1
           AND status = 'processing'`,
        [
          input.item.itemId,
          JSON.stringify({
            transientPauses: pauses,
            lastPause: { code: input.code, message: input.message, reason: input.reason, pausedAt: input.now.toISOString(),
              workerId: input.workerId, nextAttemptAt: nextAttemptAt.toISOString() },
          }),
          input.now,
        ],
      );
      await recordAuditEvent(client, {
        vendorId: job.vendor_id,
        storeConnectionId: job.store_connection_id,
        entityType: "dropship_listing_push_job",
        entityId: String(job.id),
        eventType: "listing_push_job_paused",
        actorId: input.workerId,
        severity: "warning",
        payload: {
          runId: job.run_id === null ? null : toSafeId(job.run_id, "run_id"), itemId: input.item.itemId, code: input.code,
          reason: input.reason, itemPauses: pauses, consecutivePauseCount, nextAttemptAt: nextAttemptAt.toISOString(),
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { outcome: "paused", job: mapJobRow(job), consecutivePauseCount, nextAttemptAt };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async tripJobBreaker(input: Parameters<DropshipListingPushWorkerRepository["tripJobBreaker"]>[0]): Promise<{
    failedItemIds: number[]; runStopped: boolean;
  }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // Lock order: the run, then the job, then its items (as a stop and a chunk record take them).
      const runId = input.job.runId ?? null;
      if (runId !== null) {
        await client.query("SELECT id FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE", [runId]);
      }
      const locked = await findJobForUpdate(client, input.job.jobId);
      if (!locked) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", { jobId: input.job.jobId });
      }
      // The breaker uses up the job's pauses: a staff retry of this job starts with a fresh backoff.
      await client.query(
        `UPDATE dropship.dropship_listing_push_jobs
         SET consecutive_pause_count = 0, next_attempt_at = NULL, updated_at = $2
         WHERE id = $1`,
        [input.job.jobId, input.now],
      );
      const pushResult = JSON.stringify({
        push: { status: "failed", errorCode: input.code, errorMessage: input.message, retryable: true,
          workerId: input.workerId, processedAt: input.now.toISOString() },
      });
      const failed = await client.query<{ id: number; listing_id: number | null }>(
        `UPDATE dropship.dropship_listing_push_job_items
         SET status = 'failed', error_code = $2, error_message = $3,
             result = COALESCE(result, '{}'::jsonb) || $4::jsonb, updated_at = $5
         WHERE job_id = $1 AND status IN ('queued', 'processing')
         RETURNING id, listing_id`,
        [input.job.jobId, input.code, input.message, pushResult, input.now],
      );
      const listingIds = failed.rows.map((row) => row.listing_id).filter((id): id is number => id !== null);
      // Each failed item's listing, before -> after, for the sync events and the audit row.
      let listingStatuses: Array<{ listingId: number; before: string; after: string }> = [];
      if (listingIds.length > 0) {
        // As a failed item marks its listing (markItemTerminalFailure), for every item at once, under the same rule: a
        // listing live on its marketplace keeps its live status, so it still takes orders (domain/listing-live-status);
        // the error is still recorded on it. Rows are locked in id order, so two writers never wait on each other in
        // opposite orders; the CTE only reports the status before the update.
        const updated = await client.query<{ id: number; previous_status: string; status: string }>(
          `WITH current_listing AS (
             SELECT id, status FROM dropship.dropship_vendor_listings
             WHERE id = ANY($1::int[])
             ORDER BY id
             FOR UPDATE
           )
           UPDATE dropship.dropship_vendor_listings AS listing
           SET status = CASE
                 WHEN NULLIF(BTRIM(listing.external_listing_id), '') IS NOT NULL
                   AND listing.status = ANY($4::text[])
                 THEN listing.status
                 ELSE 'failed'
               END,
               metadata = COALESCE(listing.metadata, '{}'::jsonb) || $2::jsonb,
               updated_at = $3
           FROM current_listing
           WHERE listing.id = current_listing.id
           RETURNING listing.id, current_listing.status AS previous_status, listing.status`,
          [listingIds, JSON.stringify({ lastPushError: { jobId: input.job.jobId, code: input.code, message: input.message,
            retryable: true, workerId: input.workerId } }), input.now, [...LIVE_LISTING_STATUSES]],
        );
        listingStatuses = updated.rows
          .map((row) => ({ listingId: row.id, before: row.previous_status, after: row.status }))
          .sort((left, right) => left.listingId - right.listingId);
        await client.query(
          `INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
           SELECT failed.listing_id, 'listing_push_failed', 'dropship_worker',
                  $2::jsonb || jsonb_build_object('listingStatus',
                    CASE WHEN failed.before_status IS NULL THEN NULL
                         ELSE jsonb_build_object('before', failed.before_status, 'after', failed.after_status) END),
                  $3
           FROM unnest($1::int[], $4::text[], $5::text[]) AS failed(listing_id, before_status, after_status)`,
          [
            listingIds,
            JSON.stringify({ jobId: input.job.jobId, code: input.code, message: input.message, retryable: true }),
            input.now,
            listingIds.map((listingId) => listingStatuses.find((row) => row.listingId === listingId)?.before ?? null),
            listingIds.map((listingId) => listingStatuses.find((row) => row.listingId === listingId)?.after ?? null),
          ],
        );
      }
      // The failed items' run targets follow in the same transaction (verify V1).
      await syncRunTargetsOfItems(client, { itemIds: failed.rows.map((row) => row.id) });
      let runStopped = false;
      // The run's sizes this trip decided, before -> after, for the audit row (review MC8).
      let failedTargetVariantIds: number[] = [];
      if (runId !== null) {
        const run = await client.query(
          `UPDATE dropship.dropship_listing_push_runs
           SET stop_reason = COALESCE(stop_reason, 'provider_unavailable'), updated_at = $2
           WHERE id = $1 AND status = 'processing'`,
          [runId, input.now],
        );
        runStopped = run.rowCount === 1;
        if (runStopped) {
          // The run's sizes not yet handed to a job fail too, so the run finishes at the next reconcile (SAFETY7).
          const failedTargets = await client.query<{ product_variant_id: number }>(
            `UPDATE dropship.dropship_listing_push_run_targets
             SET outcome = 'failed', code = $2, retryable = true, decided_at = $3
             WHERE run_id = $1 AND outcome = 'pending'
             RETURNING product_variant_id`,
            [runId, input.code, input.now],
          );
          failedTargetVariantIds = failedTargets.rows.map((row) => row.product_variant_id).sort((left, right) => left - right);
        }
      }
      await recordAuditEvent(client, {
        vendorId: input.job.vendorId,
        storeConnectionId: input.job.storeConnectionId,
        entityType: "dropship_listing_push_job",
        entityId: String(input.job.jobId),
        eventType: "listing_push_job_breaker_tripped",
        actorId: input.workerId,
        severity: "warning",
        payload: { runId, code: input.code, itemId: input.item.itemId, failedItemIds: failed.rows.map((row) => row.id),
          consecutivePauseCount: locked.consecutive_pause_count ?? 0, runStopped, listingStatuses,
          // Every run size the trip decided: pending -> failed (retryable), apart from those the reconcile copies from items.
          failedTargets: { before: "pending", after: "failed", productVariantIds: failedTargetVariantIds } },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { failedItemIds: failed.rows.map((row) => row.id), runStopped };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markItemTerminalFailure(input: {
    job: DropshipListingPushWorkerJobRecord;
    item: DropshipListingPushWorkerItemRecord;
    status: "failed" | "blocked";
    code: string;
    message: string;
    retryable: boolean;
    providerErrors?: ReadonlyArray<Record<string, unknown>>;
    endpoint?: string | null;
    context?: Record<string, unknown>;
    endsPauseRun?: boolean;
    workerId: string;
    eventType: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerItemRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      if (input.endsPauseRun === true) {
        // eBay gave a definite answer, so its run of pauses ends, as a completed push ends it (review round 2 MC4). The
        // job before its item.
        await client.query(
          `UPDATE dropship.dropship_listing_push_jobs
           SET consecutive_pause_count = 0
           WHERE id = $1
             AND consecutive_pause_count <> 0`,
          [input.job.jobId],
        );
      }
      // Only an item still queued or being sent is decided here (review MC9): one a stop cancelled after the claim read
      // it keeps its cancel, and its listing, sync events and audit trail get nothing it did not do.
      const decided = await updateJobItemTerminalStatus(client, {
        itemId: input.item.itemId,
        onlyFrom: ["queued", "processing"],
        status: input.status,
        externalListingId: input.item.externalListingId,
        errorCode: input.code,
        errorMessage: input.message,
        resultPatch: {
          push: {
            status: input.status,
            errorCode: input.code,
            errorMessage: input.message,
            retryable: input.retryable,
            ...(input.providerErrors ? { providerErrors: input.providerErrors } : {}),
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
            ...(input.context ? { context: input.context } : {}),
            workerId: input.workerId,
            processedAt: input.now.toISOString(),
          },
        },
        now: input.now,
      });
      if (!decided) {
        const current = await getJobItemWithClient(client, input.item.itemId);
        await client.query("COMMIT");
        return current;
      }
      let listingStatus: { before: string; after: string } | null = null;
      if (input.item.listingId !== null) {
        // A failed or blocked update of a listing that is live on its
        // marketplace changed nothing buyers see: it keeps its live status, so
        // it still takes orders (domain/listing-live-status). The error is
        // still recorded on the listing, its sync history and the audit trail.
        // Decided on the locked row in one statement; the CTE only reports the
        // status before the update for the audit row.
        const updated = await client.query<{ previous_status: string; status: string }>(
          `WITH current_listing AS (
             SELECT id, status FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE
           )
           UPDATE dropship.dropship_vendor_listings AS listing
           SET status = CASE
                 WHEN NULLIF(BTRIM(listing.external_listing_id), '') IS NOT NULL
                   AND listing.status = ANY($5::text[])
                 THEN listing.status
                 ELSE $2
               END,
               metadata = COALESCE(listing.metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = $4
           FROM current_listing
           WHERE listing.id = current_listing.id
           RETURNING current_listing.status AS previous_status, listing.status`,
          [
            input.item.listingId,
            input.status,
            JSON.stringify({
              lastPushError: {
                jobId: input.job.jobId,
                jobItemId: input.item.itemId,
                code: input.code,
                message: input.message,
                retryable: input.retryable,
                workerId: input.workerId,
              },
            }),
            input.now,
            [...LIVE_LISTING_STATUSES],
          ],
        );
        const row = updated.rows[0];
        listingStatus = row ? { before: row.previous_status, after: row.status } : null;
        await recordListingSyncEvent(client, {
          listingId: input.item.listingId,
          eventType: input.status === "blocked" ? "listing_push_blocked" : "listing_push_failed",
          source: "dropship_worker",
          payload: {
            jobId: input.job.jobId,
            jobItemId: input.item.itemId,
            code: input.code,
            message: input.message,
            retryable: input.retryable,
            listingStatus,
          },
          occurredAt: input.now,
        });
      }
      // The run's target takes the outcome in the same transaction (verify V1): item, listing, then target.
      await syncRunTargetsOfItems(client, { itemIds: [input.item.itemId] });
      await recordAuditEvent(client, {
        vendorId: input.job.vendorId,
        storeConnectionId: input.job.storeConnectionId,
        entityType: "dropship_listing_push_job_item",
        entityId: String(input.item.itemId),
        eventType: input.eventType,
        actorId: input.workerId,
        payload: {
          jobId: input.job.jobId,
          listingId: input.item.listingId,
          code: input.code,
          message: input.message,
          retryable: input.retryable,
          listingStatus,
        },
        occurredAt: input.now,
      });
      const item = await getJobItemWithClient(client, input.item.itemId);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findJobForUpdate(client: PoolClient, jobId: number): Promise<JobRow | null> {
  const result = await client.query<JobRow>(
    `SELECT j.id, j.vendor_id, j.store_connection_id, sc.platform, j.status,
            j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at,
            j.run_id, j.consecutive_pause_count,
            v.status AS vendor_status,
            v.entitlement_status,
            sc.status AS store_status,
            sc.setup_status,
            sc.access_token_ref,
            sc.refresh_token_ref
     FROM dropship.dropship_listing_push_jobs j
     INNER JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id
     INNER JOIN dropship.dropship_vendors v ON v.id = j.vendor_id
     WHERE j.id = $1
     FOR UPDATE OF j`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function recoverStaleProcessingJob(
  client: PoolClient,
  input: {
    job: JobRow;
    workerId: string;
    idempotencyKey: string;
    staleAfterMinutes: number;
    now: Date;
  },
): Promise<JobRow> {
  await client.query(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = 'queued',
         error_code = NULL,
         error_message = NULL,
         result = COALESCE(result, '{}'::jsonb) || $3::jsonb,
         updated_at = $2
     WHERE job_id = $1
       AND status = 'processing'`,
    [
      input.job.id,
      input.now,
      JSON.stringify({
        staleRecovery: {
          previousStatus: "processing",
          status: "queued",
          recoveredAt: input.now.toISOString(),
          workerId: input.workerId,
          staleAfterMinutes: input.staleAfterMinutes,
        },
      }),
    ],
  );

  const updated = await client.query<JobRow>(
    `UPDATE dropship.dropship_listing_push_jobs AS j
     SET status = 'processing',
         error_message = NULL,
         updated_at = $2
     WHERE j.id = $1
       AND j.status = 'processing'
     RETURNING j.id, j.vendor_id, j.store_connection_id,
               (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
               j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at,
                     j.run_id, j.consecutive_pause_count,
               (SELECT v.status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS vendor_status,
               (SELECT v.entitlement_status FROM dropship.dropship_vendors v WHERE v.id = j.vendor_id) AS entitlement_status,
               (SELECT sc.status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS store_status,
               (SELECT sc.setup_status FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS setup_status,
               (SELECT sc.access_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS access_token_ref,
               (SELECT sc.refresh_token_ref FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS refresh_token_ref`,
    [input.job.id, input.now],
  );
  const currentJob = requiredRow(updated.rows[0], "Dropship stale listing push job recovery did not return a row.");
  await recordAuditEvent(client, {
    vendorId: currentJob.vendor_id,
    storeConnectionId: currentJob.store_connection_id,
    entityType: "dropship_listing_push_job",
    entityId: String(currentJob.id),
    eventType: "listing_push_job_stale_recovered",
    actorId: input.workerId,
    severity: "warning",
    payload: {
      idempotencyKey: input.idempotencyKey,
      previousStatus: "processing",
      status: "processing",
      staleJobUpdatedAt: input.job.updated_at.toISOString(),
      staleAfterMinutes: input.staleAfterMinutes,
      reason: "listing push job exceeded stale processing threshold before completion.",
    },
    occurredAt: input.now,
  });
  return currentJob;
}

async function loadStoreListingConfig(
  client: PoolClient,
  storeConnectionId: number,
): Promise<DropshipStoreListingConfig | null> {
  const result = await client.query<StoreListingConfigRow>(
    `SELECT id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
            marketplace_config, required_config_keys, required_product_fields, is_active
     FROM dropship.dropship_store_listing_configs
     WHERE store_connection_id = $1
     LIMIT 1`,
    [storeConnectionId],
  );
  return result.rows[0] ? mapStoreListingConfigRow(result.rows[0]) : null;
}

async function listJobItemsWithClient(
  client: PoolClient,
  jobId: number,
): Promise<DropshipListingPushWorkerItemRecord[]> {
  const result = await client.query<JobItemRow>(
    `SELECT i.id, i.job_id, i.listing_id, i.product_variant_id, i.status,
            i.preview_hash, i.external_listing_id, i.error_code, i.error_message, i.result,
            l.status AS listing_status,
            l.external_listing_id AS listing_external_listing_id,
            l.external_offer_id AS listing_external_offer_id,
            l.last_preview_hash AS listing_last_preview_hash
     FROM dropship.dropship_listing_push_job_items i
     LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     WHERE i.job_id = $1
     ORDER BY i.id ASC`,
    [jobId],
  );
  return result.rows.map(mapJobItemRow);
}

async function getJobItemWithClient(
  client: PoolClient,
  itemId: number,
): Promise<DropshipListingPushWorkerItemRecord> {
  const result = await client.query<JobItemRow>(
    `SELECT i.id, i.job_id, i.listing_id, i.product_variant_id, i.status,
            i.preview_hash, i.external_listing_id, i.error_code, i.error_message, i.result,
            l.status AS listing_status,
            l.external_listing_id AS listing_external_listing_id,
            l.external_offer_id AS listing_external_offer_id,
            l.last_preview_hash AS listing_last_preview_hash
     FROM dropship.dropship_listing_push_job_items i
     LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     WHERE i.id = $1
     LIMIT 1`,
    [itemId],
  );
  return mapJobItemRow(requiredRow(result.rows[0], "Dropship listing push job item was not found."));
}

/**
 * Writes an item's final state. `onlyFrom` limits it to items still in those
 * states (a refusal must never overwrite a stop's cancel, review MC9); true
 * when the item was written. A completed push is always recorded: eBay
 * already holds it, so its listing id must never be lost.
 */
async function updateJobItemTerminalStatus(
  client: PoolClient,
  input: {
    itemId: number;
    onlyFrom?: readonly string[];
    status: "completed" | "failed" | "blocked";
    externalListingId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    resultPatch: Record<string, unknown>;
    now: Date;
  },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = $2,
         external_listing_id = $3,
         error_code = $4,
         error_message = $5,
         result = COALESCE(result, '{}'::jsonb) || $6::jsonb,
         updated_at = $7
     WHERE id = $1
       AND ($8::text[] IS NULL OR status = ANY($8::text[]))`,
    [
      input.itemId,
      input.status,
      input.externalListingId,
      input.errorCode,
      input.errorMessage,
      JSON.stringify(input.resultPatch),
      input.now,
      input.onlyFrom ? [...input.onlyFrom] : null,
    ],
  );
  return result.rowCount === 1;
}

async function recordListingSyncEvent(
  client: PoolClient,
  input: {
    listingId: number;
    eventType: string;
    source: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_listing_sync_events
      (listing_id, event_type, source, payload, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      input.listingId,
      input.eventType,
      input.source,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

async function recordAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    entityType: string;
    entityId: string;
    eventType: string;
    actorId: string;
    severity?: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'job', $6, $7, $8::jsonb, $9)`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.entityType,
      input.entityId,
      input.eventType,
      input.actorId,
      input.severity ?? "info",
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapJobRow(row: JobRow): DropshipListingPushWorkerJobRecord {
  return {
    jobId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    runId: row.run_id === null || row.run_id === undefined ? null : toSafeId(row.run_id, "run_id"),
    consecutivePauseCount: row.consecutive_pause_count ?? 0,
  };
}

/** A bigint id from the database (node-postgres returns text): a whole number JavaScript holds exactly. */
function toSafeId(value: string | number, name: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${name}: ${String(value)}`);
  return id;
}

function mapJobEligibility(row: JobRow): DropshipListingPushWorkerEligibility {
  return {
    vendorStatus: row.vendor_status,
    entitlementStatus: row.entitlement_status,
    storeStatus: row.store_status,
    setupStatus: row.setup_status,
    storeLaunchReady: isDropshipStoreConnectionLaunchReady({
      platform: row.platform,
      status: row.store_status,
      setupStatus: row.setup_status,
      hasAccessToken: row.access_token_ref !== null,
      hasRefreshToken: row.refresh_token_ref !== null,
    }),
  };
}

function mapStoreListingConfigRow(row: StoreListingConfigRow): DropshipStoreListingConfig {
  return {
    id: row.id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    listingMode: row.listing_mode,
    inventoryMode: row.inventory_mode,
    priceMode: row.price_mode,
    marketplaceConfig: row.marketplace_config ?? {},
    requiredConfigKeys: stringArrayFromJson(row.required_config_keys),
    requiredProductFields: stringArrayFromJson(row.required_product_fields),
    isActive: row.is_active,
  };
}

function mapJobItemRow(row: JobItemRow): DropshipListingPushWorkerItemRecord {
  return {
    itemId: row.id,
    jobId: row.job_id,
    listingId: row.listing_id,
    productVariantId: row.product_variant_id,
    status: row.status,
    previewHash: row.preview_hash,
    externalListingId: row.external_listing_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    result: row.result,
    listing: row.listing_id === null ? null : {
      listingId: row.listing_id,
      productVariantId: row.product_variant_id,
      status: row.listing_status ?? "not_listed",
      externalListingId: row.listing_external_listing_id,
      externalOfferId: row.listing_external_offer_id,
      lastPreviewHash: row.listing_last_preview_hash,
    },
  };
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function requiredNumber(value: number | null, message: string): number {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

function isStaleProcessingJob(job: JobRow, now: Date, staleAfterMinutes: number): boolean {
  return job.updated_at.getTime() <= now.getTime() - staleAfterMinutes * 60_000;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
