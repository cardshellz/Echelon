import type { PoolClient } from "pg";
import { LISTING_PUSH_RUN_CODES, isItemInFlightAtStop } from "../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS } from "../domain/listing-push-run-words";

/**
 * The writes a publish run shares between its stop, its chunk record and the
 * item worker (step 1 plan S2-5, PR A; verify V1, V2, V7). Each runs inside
 * the caller's transaction, after the caller has taken the run, then the job,
 * then the item, in that order (the order every run writer keeps).
 */
type Queryable = Pick<PoolClient, "query">;

/**
 * A target's outcome from its job item, in SQL: the same mapping as
 * runTargetOutcomeForItem (domain/listing-push-run.ts), which the PostgreSQL
 * suite checks row for row. `i` is the job item's alias.
 */
export function targetOutcomeFromItemSql(i: string): string {
  return `(CASE ${i}.status
    WHEN 'queued' THEN 'queued'
    WHEN 'processing' THEN 'queued'
    WHEN 'completed' THEN 'completed'
    WHEN 'blocked' THEN CASE WHEN ${i}.error_code = '${LISTING_PUSH_RUN_CODES.notSelected}' THEN 'skipped' ELSE 'blocked' END
    WHEN 'failed' THEN CASE WHEN ${i}.error_code = '${LISTING_PUSH_RUN_CODES.priceAwaitingReview}' THEN 'price_review' ELSE 'failed' END
    WHEN 'cancelled' THEN 'cancelled'
  END)`;
}

/** What the item worker stored as the failure's retry class; null when the item has no push outcome yet. */
export function itemRetryableSql(i: string): string {
  return `(${i}.result->'push'->>'retryable')::boolean`;
}

/**
 * The targets of these items take their items' final outcome now, in the
 * transaction that decided the item (verify V1), so a run's counts move with
 * every size instead of once per sweep. Only targets of a run still
 * processing: a finished run's target changes only through the reconcile,
 * which writes the audit row for it (SAFETY17). The same values the reconcile
 * copies, so it finds nothing left to change. Returns how many changed.
 */
export async function syncRunTargetsOfItems(client: Queryable, input: { itemIds: readonly number[] }): Promise<number> {
  if (input.itemIds.length === 0) return 0;
  const result = await client.query(
    `UPDATE dropship.dropship_listing_push_run_targets t
     SET outcome = ${targetOutcomeFromItemSql("i")}, code = i.error_code, retryable = ${itemRetryableSql("i")},
         decided_at = i.updated_at
     FROM dropship.dropship_listing_push_job_items i
     WHERE i.id = ANY($1::int[]) AND t.job_item_id = i.id
       AND i.status IN ('completed', 'failed', 'blocked', 'cancelled')
       AND EXISTS (SELECT 1 FROM dropship.dropship_listing_push_runs r WHERE r.id = t.run_id AND r.status = 'processing')
       AND (${targetOutcomeFromItemSql("i")}, i.error_code, ${itemRetryableSql("i")}) IS DISTINCT FROM (t.outcome, t.code, t.retryable)`,
    [[...input.itemIds]],
  );
  return result.rowCount ?? 0;
}

/**
 * Cancels the queued items of a stopped run (all its jobs, or one job), never
 * one whose last send's outcome on eBay is unknown (verify V2,
 * isItemInFlightAtStop): that one is sent once more, so the connector adopts
 * or flags what eBay holds. The items are locked here, after the caller's run
 * (and job) locks. Returns the cancelled ids and the ids kept to finish.
 */
export async function cancelQueuedRunItems(client: Queryable, input: {
  runId: number; jobId?: number; now: Date;
}): Promise<{ cancelled: number[]; keptInFlight: number[] }> {
  const queued = await client.query<{ id: number; stale_recovery: unknown; push: unknown }>(
    `SELECT i.id, i.result->'staleRecovery' AS stale_recovery, i.result->'push' AS push
     FROM dropship.dropship_listing_push_job_items i
     JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
     WHERE j.run_id = $1 AND ($2::int IS NULL OR i.job_id = $2) AND i.status = 'queued'
     ORDER BY i.id
     FOR UPDATE OF i`,
    [input.runId, input.jobId ?? null],
  );
  const keptInFlight: number[] = [];
  const toCancel: number[] = [];
  for (const row of queued.rows) {
    const result = { staleRecovery: row.stale_recovery, push: row.push } as Record<string, unknown>;
    (isItemInFlightAtStop(result) ? keptInFlight : toCancel).push(row.id);
  }
  if (toCancel.length === 0) return { cancelled: [], keptInFlight };
  const cancelled = await client.query<{ id: number }>(
    `UPDATE dropship.dropship_listing_push_job_items AS i
     SET status = 'cancelled', error_code = $2, error_message = $3,
         result = COALESCE(i.result, '{}'::jsonb) || $4::jsonb, updated_at = $5
     WHERE i.id = ANY($1::int[]) AND i.status = 'queued'
     RETURNING i.id`,
    [toCancel, LISTING_PUSH_RUN_CODES.stopped, LISTING_PUSH_RUN_WORDS.itemStopped,
      JSON.stringify({ runStop: { runId: input.runId, cancelledAt: input.now.toISOString() } }), input.now],
  );
  return { cancelled: cancelled.rows.map((row) => row.id).sort((left, right) => left - right), keptInFlight };
}

/**
 * A cancelled item never reached eBay (a stop cancelled it while queued, or
 * eBay answered its send with "busy" after the stop), so its listing goes back
 * to the status it had before the push was queued (`listingStatusBeforeQueue`,
 * recorded at queue time) instead of staying `queued`, which other readers
 * take for a push in flight (verify V7; the rules conversion's D9b guard).
 * Only while the listing still reads `queued` and no other item of it is
 * queued or being sent; one sync event per listing, before -> after.
 */
export async function restoreListingsOfCancelledItems(client: Queryable, input: {
  itemIds: readonly number[]; source: string; now: Date;
}): Promise<Array<{ listingId: number; itemId: number; status: string }>> {
  if (input.itemIds.length === 0) return [];
  const restored = await client.query<{ listing_id: number; item_id: number; status: string }>(
    `UPDATE dropship.dropship_vendor_listings l
     SET status = i.result->>'listingStatusBeforeQueue', updated_at = $2
     FROM dropship.dropship_listing_push_job_items i
     WHERE i.id = ANY($1::int[]) AND i.status = 'cancelled' AND l.id = i.listing_id AND l.status = 'queued'
       AND i.result->>'listingStatusBeforeQueue' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items o
                       WHERE o.listing_id = l.id AND o.id <> i.id AND o.status IN ('queued', 'processing'))
     RETURNING l.id AS listing_id, i.id AS item_id, l.status`,
    [[...input.itemIds], input.now],
  );
  if (restored.rows.length > 0) {
    await client.query(
      `INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
       SELECT restored.listing_id, 'listing_push_cancelled', $4,
              jsonb_build_object('jobItemId', restored.item_id, 'before', 'queued', 'after', restored.status), $5
       FROM unnest($1::int[], $2::int[], $3::text[]) AS restored(listing_id, item_id, status)`,
      [restored.rows.map((row) => row.listing_id), restored.rows.map((row) => row.item_id),
        restored.rows.map((row) => row.status), input.source, input.now],
    );
  }
  return restored.rows.map((row) => ({ listingId: row.listing_id, itemId: row.item_id, status: row.status }));
}
