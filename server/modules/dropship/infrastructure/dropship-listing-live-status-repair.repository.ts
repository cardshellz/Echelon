import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  DEMOTED_LIVE_LISTING_STATUSES,
  decideDemotedLiveListingRestore,
} from "../domain/listing-live-status";
import type {
  DemotedLiveListingRepairResult,
  DropshipLiveListingStatusRepairPort,
  DropshipRecoveryRowFailure,
  LiveListingReviewRequired,
  RestoredLiveListing,
} from "../application/dropship-listing-push-recovery-service";
import { classifyRecoveryError, recoveryErrorCode, recoveryErrorMessage } from "./dropship-listing-recovery-errors";

interface CandidateRow { id: number }

interface LockedListingRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  product_variant_id: number;
  status: string;
  external_listing_id: string | null;
}

interface ItemEvidenceRow {
  in_flight: boolean;
  latest_item_id: number | null;
  latest_item_status: string | null;
  latest_item_error_code: string | null;
  latest_item_updated_at: Date | null;
  completed_item_id: number | null;
  completed_listing_mode: string | null;
  completed_updated_at: Date | null;
}

/** Statuses of a push item whose own outcome will still set the listing's status. */
const IN_FLIGHT_ITEM_STATUSES = ["queued", "processing"] as const;

/**
 * The order in which push items last wrote their listing (domain
 * listing-live-status PushItemWrite): the item's updated_at, then its id.
 * Not the id alone, because a retry of an older job can end after a newer
 * job's push completed.
 */
const LAST_WRITE_ORDER = "i.updated_at DESC, i.id DESC";

/**
 * Gives a listing that is live on its marketplace back the status an earlier
 * queue or failed push wrote over (domain/listing-live-status). Each listing is
 * its own transaction: the row is locked (SKIP LOCKED, so a push holding it is
 * left alone and seen again next pass), its evidence re-read under the lock,
 * decided by the domain rule, and the restore, its sync event and its audit row
 * commit together. A restored listing is live, so a re-run selects nothing:
 * the repair is idempotent. A listing whose evidence does not decide a status
 * is marked for review once (with the push item that had written last when it
 * was judged) and not selected again until another push item writes after it.
 */
export class PgDropshipListingLiveStatusRepairRepository implements DropshipLiveListingStatusRepairPort {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async restoreDemotedLiveListings(input: { now: Date; workerId: string; limit: number }): Promise<DemotedLiveListingRepairResult> {
    const result: DemotedLiveListingRepairResult = { restored: [], reviewRequired: [], failed: [], skipped: 0 };
    const candidates = await this.dbPool.query<CandidateRow>(
      `SELECT l.id
       FROM dropship.dropship_vendor_listings l
       WHERE l.status = ANY($1::text[])
         AND NULLIF(BTRIM(l.external_listing_id), '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM dropship.dropship_listing_push_job_items i
           WHERE i.listing_id = l.id AND i.status = ANY($2::text[]))
         AND NOT (
           COALESCE(l.metadata -> 'liveStatusRepair' ->> 'state', '') = 'requires_review'
           AND COALESCE(l.metadata -> 'liveStatusRepair' ->> 'latestItemId', '')
             = COALESCE((SELECT i.id FROM dropship.dropship_listing_push_job_items i WHERE i.listing_id = l.id
                         ORDER BY ${LAST_WRITE_ORDER} LIMIT 1)::text, ''))
       ORDER BY l.id ASC
       LIMIT $3`,
      [[...DEMOTED_LIVE_LISTING_STATUSES], [...IN_FLIGHT_ITEM_STATUSES], input.limit],
    );
    for (const candidate of candidates.rows) {
      try {
        const outcome = await this.restoreOne(candidate.id, input);
        if (outcome.kind === "restored") result.restored.push(outcome.listing);
        else if (outcome.kind === "requires_review") result.reviewRequired.push(outcome.listing);
        else result.skipped += 1;
      } catch (error) {
        result.failed.push(await this.recordFailure(candidate.id, error, input));
      }
    }
    return result;
  }

  private async restoreOne(listingId: number, input: { now: Date; workerId: string }): Promise<
    | { kind: "restored"; listing: RestoredLiveListing }
    | { kind: "requires_review"; listing: LiveListingReviewRequired }
    | { kind: "skipped" }
  > {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedListingRow>(
        `SELECT id, vendor_id, store_connection_id, product_variant_id, status, external_listing_id
         FROM dropship.dropship_vendor_listings
         WHERE id = $1
         FOR UPDATE SKIP LOCKED`,
        [listingId],
      );
      const listing = locked.rows[0];
      if (!listing) {
        await client.query("COMMIT");
        return { kind: "skipped" };
      }
      const evidence = await readItemEvidence(client, listingId);
      const decision = decideDemotedLiveListingRestore({
        listingId,
        status: listing.status,
        externalListingId: listing.external_listing_id,
        hasInFlightItem: evidence.in_flight,
        lastCompletedItem: evidence.completed_item_id === null || evidence.completed_updated_at === null ? null : {
          itemId: evidence.completed_item_id,
          listingMode: evidence.completed_listing_mode,
          wroteAt: evidence.completed_updated_at,
        },
        latestWrite: evidence.latest_item_id === null || evidence.latest_item_updated_at === null ? null : {
          itemId: evidence.latest_item_id,
          wroteAt: evidence.latest_item_updated_at,
        },
      });
      if (decision.kind === "skip") {
        await client.query("COMMIT");
        return { kind: "skipped" };
      }
      if (decision.kind === "requires_review") {
        await markForReview(client, {
          listing, code: decision.code, message: decision.message, latestItemId: evidence.latest_item_id, ...input,
        });
        await client.query("COMMIT");
        return {
          kind: "requires_review",
          listing: {
            listingId, vendorId: listing.vendor_id, storeConnectionId: listing.store_connection_id,
            productVariantId: listing.product_variant_id, status: listing.status, code: decision.code, message: decision.message,
          },
        };
      }
      const latestItemId = evidence.latest_item_id!;
      const repair = {
        state: "restored",
        previousStatus: listing.status,
        status: decision.status,
        basisJobItemId: decision.basisItemId,
        // The item that wrote last (the one whose queue, retry or failure demoted the listing).
        latestItemId,
        latestItemStatus: evidence.latest_item_status,
        latestItemErrorCode: evidence.latest_item_error_code,
        repairedAt: input.now.toISOString(),
        workerId: input.workerId,
      };
      const updated = await client.query(
        `UPDATE dropship.dropship_vendor_listings
         SET status = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = $4
         WHERE id = $1 AND status = $5`,
        [listingId, decision.status, JSON.stringify({ liveStatusRepair: repair }), input.now, listing.status],
      );
      if (updated.rowCount !== 1) {
        // The row is locked by this transaction; a miss means the lock did not hold.
        throw new Error("Live listing status repair did not update the locked listing row.");
      }
      await client.query(
        `INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
         VALUES ($1, 'listing_live_status_restored', 'dropship_worker', $2::jsonb, $3)`,
        [listingId, JSON.stringify(repair), input.now],
      );
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, 'dropship_vendor_listing', $3, 'listing_live_status_restored', 'job', $4, 'warning', $5::jsonb, $6)`,
        [
          listing.vendor_id,
          listing.store_connection_id,
          String(listingId),
          input.workerId,
          JSON.stringify({
            before: { status: listing.status },
            after: { status: decision.status },
            basisJobItemId: decision.basisItemId,
            latestItemId,
            latestItemStatus: evidence.latest_item_status,
            latestItemErrorCode: evidence.latest_item_error_code,
            reason: "A queue or failed push wrote a non-live status over a listing that stayed live on its marketplace.",
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return {
        kind: "restored",
        listing: {
          listingId, vendorId: listing.vendor_id, storeConnectionId: listing.store_connection_id,
          productVariantId: listing.product_variant_id, previousStatus: listing.status, status: decision.status,
          basisItemId: decision.basisItemId, latestItemId,
          latestItemStatus: evidence.latest_item_status, latestItemErrorCode: evidence.latest_item_error_code,
        },
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A permanent failure is marked so the listing is not tried again every
   * pass (never retry a permanent error); a transient one is left for the next
   * pass. The mark is its own transaction, after the failed one rolled back.
   */
  private async recordFailure(listingId: number, error: unknown, input: { now: Date; workerId: string }): Promise<DropshipRecoveryRowFailure> {
    const classification = classifyRecoveryError(error);
    const failure: DropshipRecoveryRowFailure = {
      entity: "dropship_vendor_listing", entityId: listingId, code: recoveryErrorCode(error),
      message: recoveryErrorMessage(error), classification, markedForReview: false,
    };
    if (classification !== "permanent") return failure;
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedListingRow>(
        `SELECT id, vendor_id, store_connection_id, product_variant_id, status, external_listing_id
         FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [listingId],
      );
      const listing = locked.rows[0];
      if (listing) {
        const evidence = await readItemEvidence(client, listingId);
        await markForReview(client, {
          listing, code: failure.code, message: failure.message, latestItemId: evidence.latest_item_id, ...input,
        });
        failure.markedForReview = true;
      }
      await client.query("COMMIT");
    } catch (markError) {
      // Reported with the failure (and logged by the caller); the mark is
      // tried again with the row on the next pass.
      await rollbackQuietly(client);
      failure.markedForReview = false;
      failure.message = `${failure.message} (review mark failed: ${recoveryErrorMessage(markError)})`;
    } finally {
      client.release();
    }
    return failure;
  }
}

async function readItemEvidence(client: PoolClient, listingId: number): Promise<ItemEvidenceRow> {
  const evidence = await client.query<ItemEvidenceRow>(
    `SELECT
       EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items i
               WHERE i.listing_id = $1 AND i.status = ANY($2::text[])) AS in_flight,
       latest.id AS latest_item_id, latest.status AS latest_item_status, latest.error_code AS latest_item_error_code,
       latest.updated_at AS latest_item_updated_at,
       completed.id AS completed_item_id, completed.listing_mode AS completed_listing_mode, completed.updated_at AS completed_updated_at
     FROM (SELECT 1) AS one
     LEFT JOIN LATERAL (
       SELECT i.id, i.status, i.error_code, i.updated_at FROM dropship.dropship_listing_push_job_items i
       WHERE i.listing_id = $1 ORDER BY ${LAST_WRITE_ORDER} LIMIT 1) latest ON true
     LEFT JOIN LATERAL (
       SELECT i.id, i.updated_at,
              COALESCE(i.result -> 'push' -> 'rawResult' ->> 'listingMode', i.result -> 'listingIntent' ->> 'listingMode') AS listing_mode
       FROM dropship.dropship_listing_push_job_items i
       WHERE i.listing_id = $1 AND i.status = 'completed' ORDER BY ${LAST_WRITE_ORDER} LIMIT 1) completed ON true`,
    [listingId, [...IN_FLIGHT_ITEM_STATUSES]],
  );
  return evidence.rows[0]!;
}

async function markForReview(client: PoolClient, input: {
  listing: LockedListingRow;
  code: string;
  message: string;
  latestItemId: number | null;
  now: Date;
  workerId: string;
}): Promise<void> {
  const marker = {
    state: "requires_review",
    status: input.listing.status,
    code: input.code,
    message: input.message,
    // Selected again only once another push item of this listing has written after this one.
    latestItemId: input.latestItemId === null ? "" : String(input.latestItemId),
    markedAt: input.now.toISOString(),
    workerId: input.workerId,
  };
  await client.query(
    `UPDATE dropship.dropship_vendor_listings
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE id = $1`,
    [input.listing.id, JSON.stringify({ liveStatusRepair: marker }), input.now],
  );
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_vendor_listing', $3, 'listing_live_status_review_required', 'job', $4, 'error', $5::jsonb, $6)`,
    [
      input.listing.vendor_id,
      input.listing.store_connection_id,
      String(input.listing.id),
      input.workerId,
      JSON.stringify({ requiresReview: true, code: input.code, message: input.message, status: input.listing.status,
        latestItemId: input.latestItemId }),
      input.now,
    ],
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
