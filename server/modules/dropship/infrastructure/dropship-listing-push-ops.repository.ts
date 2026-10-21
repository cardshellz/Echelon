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
  RequeuedAccountVerificationJob,
} from "../application/dropship-listing-push-recovery-service";
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

export class PgDropshipListingPushOpsRepository implements DropshipListingPushOpsRepository, DropshipAccountVerificationRequeuePort {
  constructor(private readonly dbPool: Pool = defaultPool) {}

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
  // classifyListingPushError) is permanent: never re-queued automatically,
  // including by the stock catch-up, which retries as the system. Once the
  // setup is done, an admin's retry is how it is re-driven (the dead-letter
  // redrive); nothing else re-runs it.
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
