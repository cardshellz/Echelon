import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  LISTING_PUSH_RUN_PROBLEM_OUTCOMES,
  type ListingPushRunProblem,
  type ListingPushRunProblemOutcome,
} from "../../../../shared/dropship/listing-push-runs";
import type {
  DropshipListingPushRunSweepRepository,
  ListingPushRunChunkFacts,
  ListingPushRunChunkFailure,
  ListingPushRunCodeCount,
  ListingPushRunFinished,
} from "../application/dropship-listing-push-run-sweep";
import type { DropshipListingPushRunRecord } from "../application/dropship-listing-push-run-service";
import { selectedVariantIdsAmong } from "../application/dropship-selected-catalog";
import {
  LISTING_PUSH_RUN_CODES,
  RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS,
  RUN_PRICE_INPUT_CLOCK_MARGIN_MS,
  RUN_UNREQUEUED_STOCK_LINK_CODES,
  countListingPushRunTargets,
  decideListingPushRunFinish,
  isLiveListing,
} from "../domain/listing-push-run";
import { isPushProgressListingOnMarketplace } from "../domain/order-listing-acceptability";
import {
  LISTING_PUSH_RUN_COLUMNS,
  insertRunAuditEvent,
  mapListingPushRunRow,
  readRunCounts,
  toRunId,
  type ListingPushRunRow,
} from "./dropship-listing-push-run.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import {
  cancelQueuedRunItems,
  itemRetryableSql,
  restoreListingsOfCancelledItems,
  targetOutcomeFromItemSql,
} from "./dropship-listing-push-run-items";

export { targetOutcomeFromItemSql };

type Queryable = Pick<PoolClient, "query">;

/** The sweep's own actor on run audit rows. */
const SWEEP_ACTOR = { actorType: "system", actorId: "dropship-listing-push-sweep" } as const;

/**
 * A listing-setting revision (product 0738, category 0739) whose price recipe
 * differs from the revision it replaced: only a price change moves the rule
 * price, so a text or category edit holds nothing. With no earlier revision
 * the old recipe is all null, so the first recipe saved counts as a move.
 */
function priceRecipeMovedSql(revision: string, previous: string): string {
  return `(${revision}.price_basis, ${revision}.price_markup_bps, ${revision}.price_flat_cents, ${revision}.price_rounding)
    IS DISTINCT FROM (${previous}.price_basis, ${previous}.price_markup_bps, ${previous}.price_flat_cents, ${previous}.price_rounding)`;
}

export class PgDropshipListingPushRunSweepRepository implements DropshipListingPushRunSweepRepository {
  constructor(private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool) {}

  async reconcileTargets(input: { now: Date; activityWindowMs: number }): Promise<{ changed: number; finishedRunChanges: number }> {
    return this.inTransaction(async (client) => {
      // Run jobs whose items can still change a target: those of unfinished runs, and any run job that moved within
      // the window (a staff retry of a finished run's job moves the job, SAFETY17). Bounded: never every target ever.
      // Read first, on their own (a few job ids), so the update below is planned for those jobs' items, not for the
      // whole targets table: one statement estimated the join at every target ever written, which switched on JIT
      // compilation for about 0.5 s a sweep once the table held a million (verify V8).
      const considered = await client.query<{ id: number }>(
        `SELECT j.id FROM dropship.dropship_listing_push_jobs j
         WHERE j.run_id IS NOT NULL
           AND (j.updated_at >= $1::timestamptz - make_interval(secs => $2::double precision / 1000)
             OR j.run_id IN (SELECT r.id FROM dropship.dropship_listing_push_runs r WHERE r.status = 'processing'))`,
        [input.now, input.activityWindowMs]);
      const jobIds = considered.rows.map((row) => row.id);
      if (jobIds.length === 0) return { changed: 0, finishedRunChanges: 0 };
      const changed = await client.query<{
        run_id: string | number; product_variant_id: number; before_outcome: string; before_code: string | null;
        outcome: string; code: string | null; run_status: string; vendor_id: number; store_connection_id: number;
      }>(
        `WITH mapped AS (
           SELECT t.run_id, t.product_variant_id, t.outcome AS before_outcome, t.code AS before_code,
                  ${targetOutcomeFromItemSql("i")} AS outcome, i.error_code AS code, ${itemRetryableSql("i")} AS retryable,
                  i.updated_at
           FROM dropship.dropship_listing_push_job_items i
           JOIN dropship.dropship_listing_push_run_targets t ON t.job_item_id = i.id
           WHERE i.job_id = ANY($1::int[])
             AND i.status IN ('completed', 'failed', 'blocked', 'cancelled')
         ),
         changed AS (
           UPDATE dropship.dropship_listing_push_run_targets t
           SET outcome = m.outcome, code = m.code, retryable = m.retryable, decided_at = m.updated_at
           FROM mapped m
           WHERE t.run_id = m.run_id AND t.product_variant_id = m.product_variant_id
             AND (m.outcome, m.code, m.retryable) IS DISTINCT FROM (t.outcome, t.code, t.retryable)
           RETURNING t.run_id, t.product_variant_id, m.before_outcome, m.before_code, m.outcome, m.code
         )
         SELECT c.run_id, c.product_variant_id, c.before_outcome, c.before_code, c.outcome, c.code,
                r.status AS run_status, r.vendor_id, r.store_connection_id
         FROM changed c JOIN dropship.dropship_listing_push_runs r ON r.id = c.run_id
         ORDER BY c.run_id, c.product_variant_id`,
        [jobIds]);
      // One audit row per finished run that changed, with every change before -> after (SAFETY17).
      const finishedChanges = new Map<number, { vendorId: number; storeConnectionId: number; changes: unknown[] }>();
      for (const row of changed.rows) {
        if (row.run_status === "processing") continue;
        const runId = toRunId(row.run_id);
        const entry = finishedChanges.get(runId) ?? { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, changes: [] };
        entry.changes.push({ productVariantId: row.product_variant_id,
          before: { outcome: row.before_outcome, code: row.before_code }, after: { outcome: row.outcome, code: row.code } });
        finishedChanges.set(runId, entry);
      }
      for (const [runId, entry] of finishedChanges) {
        await insertRunAuditEvent(client, {
          vendorId: entry.vendorId, storeConnectionId: entry.storeConnectionId, runId,
          eventType: "listing_push_run_target_changed", actor: SWEEP_ACTOR,
          payload: { changes: entry.changes }, now: input.now,
        });
      }
      const finishedRunChanges = [...finishedChanges.values()].reduce((sum, entry) => sum + entry.changes.length, 0);
      return { changed: changed.rows.length, finishedRunChanges };
    });
  }

  async finishRuns(input: { now: Date; problemLimit: number }): Promise<ListingPushRunFinished[]> {
    return this.inTransaction(async (client) => {
      const runs = await client.query<ListingPushRunRow>(
        `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
         WHERE r.status = 'processing'
           AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets t
                           WHERE t.run_id = r.id AND t.outcome IN ('pending', 'queued'))
         ORDER BY r.id
         FOR UPDATE OF r`);
      const finished: ListingPushRunFinished[] = [];
      for (const row of runs.rows) {
        const run = mapListingPushRunRow(row);
        const counts = (await readRunCounts(client, [run.runId])).get(run.runId) ?? countListingPushRunTargets([]);
        const status = decideListingPushRunFinish({ counts, cancelRequested: run.cancelRequestedAt !== null });
        if (status === null) continue;
        const updated = await client.query<ListingPushRunRow>(
          `UPDATE dropship.dropship_listing_push_runs AS r
           SET status = $2, completed_at = $3, updated_at = $3
           WHERE r.id = $1 AND r.status = 'processing'
           RETURNING ${LISTING_PUSH_RUN_COLUMNS}`,
          [run.runId, status, input.now]);
        if (!updated.rows[0]) continue;
        const after = mapListingPushRunRow(updated.rows[0]);
        await insertRunAuditEvent(client, {
          vendorId: after.vendorId, storeConnectionId: after.storeConnectionId, runId: after.runId,
          eventType: "listing_push_run_finished", actor: SWEEP_ACTOR,
          severity: status === "completed" || status === "cancelled" ? "info" : "warning",
          payload: { status, stopReason: after.stopReason, counts }, now: input.now,
        });
        const store = await client.query<{ external_display_name: string | null }>(
          "SELECT external_display_name FROM dropship.dropship_store_connections WHERE id = $1", [after.storeConnectionId]);
        finished.push({ run: after, counts, problems: await readProblems(client, after.runId, input.problemLimit),
          storeName: store.rows[0]?.external_display_name ?? null,
          stockLinkFailuresNotRequeued: await readStockLinkFailuresNotRequeued(client, after.runId) });
      }
      return finished;
    });
  }

  async listExpandableRuns(input: { limit: number }): Promise<DropshipListingPushRunRecord[]> {
    const result = await this.dbPool.query<ListingPushRunRow>(
      `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
       WHERE r.status = 'processing' AND r.cancel_requested_at IS NULL
         AND EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets t WHERE t.run_id = r.id AND t.outcome = 'pending')
         -- One active chunk per run (D11): a recorded chunk job still queued or processing holds the run. A job whose
         -- chunk still has pending targets was never recorded (a crash after its commit): expansion adopts it.
         AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_jobs j
                         WHERE j.run_id = r.id AND j.status IN ('queued', 'processing')
                           AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets p
                                           WHERE p.run_id = r.id AND p.chunk_index = j.run_chunk_index AND p.outcome = 'pending'))
       ORDER BY r.id
       LIMIT $1`,
      [input.limit]);
    return result.rows.map(mapListingPushRunRow);
  }

  async nextPendingChunk(input: { runId: number }): Promise<{ chunkIndex: number; productVariantIds: number[] } | null> {
    const result = await this.dbPool.query<{ chunk_index: number; product_variant_id: number }>(
      `SELECT t.chunk_index, t.product_variant_id FROM dropship.dropship_listing_push_run_targets t
       WHERE t.run_id = $1 AND t.outcome = 'pending'
         AND t.chunk_index = (SELECT min(p.chunk_index) FROM dropship.dropship_listing_push_run_targets p
                              WHERE p.run_id = $1 AND p.outcome = 'pending')
       ORDER BY t.product_variant_id`,
      [input.runId]);
    if (result.rows.length === 0) return null;
    return { chunkIndex: result.rows[0].chunk_index, productVariantIds: result.rows.map((row) => row.product_variant_id) };
  }

  async findChunkJob(input: { runId: number; chunkIndex: number }): Promise<{ jobId: number } | null> {
    const result = await this.dbPool.query<{ id: number }>(
      "SELECT id FROM dropship.dropship_listing_push_jobs WHERE run_id = $1 AND run_chunk_index = $2",
      [input.runId, input.chunkIndex]);
    return result.rows[0] ? { jobId: result.rows[0].id } : null;
  }

  async readChunkFacts(input: { run: DropshipListingPushRunRecord; productVariantIds: readonly number[]; now: Date }): Promise<ListingPushRunChunkFacts[]> {
    const ids = [...new Set(input.productVariantIds)].sort((left, right) => left - right);
    if (ids.length === 0) return [];
    const client = await this.dbPool.connect();
    try {
      // Read only, one snapshot: the chunk's own sizes, never the whole catalog (TESTS10).
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const selected = await selectedVariantIdsAmong(
        selectedCatalogReaderForTransaction(client, input.run.vendorId), ids, input.now);
      const listings = await client.query<{ product_variant_id: number; status: string; external_listing_id: string | null }>(
        `SELECT product_variant_id, status, external_listing_id FROM dropship.dropship_vendor_listings
         WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = ANY($3::int[])`,
        [input.run.vendorId, input.run.storeConnectionId, ids]);
      // Price inputs moved after the press (D29; F14 named the first three, review MC2 and MC6 the rest a rule price
      // reads): a cost change in force now that took effect, or was recorded, after the press (0711 lets a reading take
      // effect when it was observed, before it is written); a store pricing or listing price revision saved after it
      // (0657, 0659); a product or category listing-setting revision saved after it that changed the price recipe
      // (0738, 0739). Each is measured from the press less a clock margin (review round 2 MC6). Not read, because
      // nothing records when they change: the catalog retail price (a live join of
      // Shopify prices) and Card Shellz price limits (no writer in the app); the worker's push-time check still holds a
      // price that moves after the chunk is queued (decideQueuedRulePricePublication).
      const moved = await client.query<{ product_variant_id: number }>(
        `SELECT DISTINCT ids.id AS product_variant_id
         FROM unnest($3::int[]) AS ids(id)
         WHERE EXISTS (SELECT 1 FROM dropship.dropship_cost_schedule_entries c
                       WHERE c.vendor_id = $1 AND c.product_variant_id = ids.id AND c.withdrawn_at IS NULL
                         AND c.effective_at <= $5 AND (c.effective_at > $4 OR c.created_at > $4))
            OR EXISTS (SELECT 1 FROM dropship.dropship_listing_price_revisions lp
                       WHERE lp.vendor_id = $1 AND lp.store_connection_id = $2 AND lp.product_variant_id = ids.id
                         AND lp.created_at > $4)
            OR EXISTS (SELECT 1 FROM dropship.dropship_pricing_profile_revisions pp
                       WHERE pp.vendor_id = $1 AND pp.store_connection_id = $2 AND pp.created_at > $4)
            OR EXISTS (SELECT 1 FROM catalog.product_variants pv
                       JOIN dropship.dropship_product_listing_setting_revisions pr
                         ON pr.store_connection_id = $2 AND pr.product_id = pv.product_id AND pr.vendor_id = $1
                       LEFT JOIN dropship.dropship_product_listing_setting_revisions prev ON prev.id = pr.previous_revision_id
                       WHERE pv.id = ids.id AND pr.created_at > $4 AND ${priceRecipeMovedSql("pr", "prev")})
            OR EXISTS (SELECT 1 FROM catalog.product_variants pv
                       JOIN catalog.products p ON p.id = pv.product_id
                       JOIN dropship.dropship_category_listing_setting_revisions cr
                         ON cr.store_connection_id = $2 AND cr.category_id = p.category_id AND cr.vendor_id = $1
                       LEFT JOIN dropship.dropship_category_listing_setting_revisions prev ON prev.id = cr.previous_revision_id
                       WHERE pv.id = ids.id AND cr.created_at > $4 AND ${priceRecipeMovedSql("cr", "prev")})`,
        [input.run.vendorId, input.run.storeConnectionId, ids,
          new Date(input.run.createdAt.getTime() - RUN_PRICE_INPUT_CLOCK_MARGIN_MS), input.now]);
      await client.query("COMMIT");
      const listingById = new Map(listings.rows.map((row) => [row.product_variant_id, row]));
      const movedIds = new Set(moved.rows.map((row) => row.product_variant_id));
      return ids.map((productVariantId) => {
        const listing = listingById.get(productVariantId);
        const facts = listing ? { status: listing.status, externalListingId: listing.external_listing_id } : null;
        const live = isLiveListing(facts);
        return {
          productVariantId,
          selected: selected.has(productVariantId),
          live,
          // eBay still lists it while a re-send is in progress or failed (review MC3): its price is checked too.
          onMarketplace: live || (facts !== null && isPushProgressListingOnMarketplace(facts)),
          priceInputsMoved: movedIds.has(productVariantId),
        };
      });
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPrefilter(input: {
    run: DropshipListingPushRunRecord;
    chunkIndex: number;
    outcomes: ReadonlyArray<{ productVariantId: number; outcome: "skipped" | "price_review"; code: string }>;
    now: Date;
  }): Promise<{ applied: number }> {
    if (input.outcomes.length === 0) return { applied: 0 };
    return this.inTransaction(async (client) => {
      // The run first, as every run writer takes it (a stop and the breaker lock the run, then its targets): taking
      // the targets first deadlocked with a concurrent Stop (verify V3). A stop that came first already cancelled the
      // pending targets, so there is nothing left to record.
      const run = await client.query<{ status: string; cancel_requested_at: Date | null }>(
        "SELECT status, cancel_requested_at FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE",
        [input.run.runId]);
      if (!run.rows[0] || run.rows[0].status !== "processing" || run.rows[0].cancel_requested_at !== null) return { applied: 0 };
      // Only targets still pending.
      const applied = await client.query<{ product_variant_id: number; outcome: string; code: string }>(
        `UPDATE dropship.dropship_listing_push_run_targets t
         SET outcome = o.outcome, code = o.code, retryable = false, decided_at = $5
         FROM unnest($3::int[], $4::text[], $6::text[]) AS o(product_variant_id, outcome, code)
         WHERE t.run_id = $1 AND t.chunk_index = $2 AND t.product_variant_id = o.product_variant_id AND t.outcome = 'pending'
         RETURNING t.product_variant_id, t.outcome, t.code`,
        [input.run.runId, input.chunkIndex, input.outcomes.map((row) => row.productVariantId),
          input.outcomes.map((row) => row.outcome), input.now, input.outcomes.map((row) => row.code)]);
      const idsBy = (outcome: string, code?: string) => applied.rows
        .filter((row) => row.outcome === outcome && (code === undefined || row.code === code))
        .map((row) => row.product_variant_id);
      await insertRunAuditEvent(client, {
        vendorId: input.run.vendorId, storeConnectionId: input.run.storeConnectionId, runId: input.run.runId,
        eventType: "listing_push_run_chunk_prefiltered", actor: SWEEP_ACTOR,
        payload: {
          chunkIndex: input.chunkIndex,
          notSelected: idsBy("skipped", LISTING_PUSH_RUN_CODES.notSelected),
          alreadyLive: idsBy("skipped", LISTING_PUSH_RUN_CODES.alreadyLive),
          priceReview: idsBy("price_review"),
        },
        now: input.now,
      });
      await advanceChunkWhenDecided(client, { runId: input.run.runId, chunkIndex: input.chunkIndex, now: input.now });
      return { applied: applied.rows.length };
    });
  }

  async isRunOpenForQueue(input: { runId: number }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const result = await client.query<{ status: string; cancel_requested_at: Date | null }>(
        "SELECT status, cancel_requested_at FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE",
        [input.runId]);
      const row = result.rows[0];
      return Boolean(row && row.status === "processing" && row.cancel_requested_at === null);
    });
  }

  async recordChunkQueued(input: { run: DropshipListingPushRunRecord; chunkIndex: number; jobId: number; now: Date }): Promise<{
    stopped: boolean; queued: number; decided: number; notQueued: number;
  }> {
    return this.inTransaction(async (client) => {
      const run = await client.query<{ status: string; cancel_requested_at: Date | null }>(
        "SELECT status, cancel_requested_at FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE",
        [input.run.runId]);
      const stopped = !run.rows[0] || run.rows[0].status !== "processing" || run.rows[0].cancel_requested_at !== null;
      if (stopped) {
        // A stop raced the queue (SAFETY7): nothing of this chunk may start. The job is locked before its items. An
        // item whose last send's outcome is unknown (only an older release's worker could have sent one) is kept to
        // finish (verify V2); every cancelled item's listing goes back to its status before the queue (verify V7).
        await client.query("SELECT id FROM dropship.dropship_listing_push_jobs WHERE id = $1 FOR UPDATE", [input.jobId]);
        const cancelled = await cancelQueuedRunItems(client, { runId: input.run.runId, jobId: input.jobId, now: input.now });
        await restoreListingsOfCancelledItems(client, { itemIds: cancelled.cancelled, source: "dropship_listing_push_sweep", now: input.now });
      }
      // Targets take their items' state (the stop's cancelled items included), with the job and item ids.
      const linked = await client.query<{ outcome: string }>(
        `UPDATE dropship.dropship_listing_push_run_targets t
         SET outcome = ${targetOutcomeFromItemSql("i")}, code = i.error_code, retryable = ${itemRetryableSql("i")},
             job_id = i.job_id, job_item_id = i.id, decided_at = $4
         FROM dropship.dropship_listing_push_job_items i
         WHERE i.job_id = $3 AND t.run_id = $1 AND t.chunk_index = $2
           AND t.product_variant_id = i.product_variant_id AND t.outcome = 'pending'
         RETURNING t.outcome`,
        [input.run.runId, input.chunkIndex, input.jobId, input.now]);
      // A pending size the job holds no item for (never expected) fails for good, or, after a stop, is cancelled.
      const leftover = await client.query<{ product_variant_id: number }>(
        `UPDATE dropship.dropship_listing_push_run_targets
         SET outcome = $3, code = $4, retryable = false, decided_at = $5
         WHERE run_id = $1 AND chunk_index = $2 AND outcome = 'pending'
         RETURNING product_variant_id`,
        [input.run.runId, input.chunkIndex, stopped ? "cancelled" : "failed",
          stopped ? LISTING_PUSH_RUN_CODES.stopped : LISTING_PUSH_RUN_CODES.targetNotQueued, input.now]);
      await client.query(
        `UPDATE dropship.dropship_listing_push_runs
         SET next_chunk_index = GREATEST(next_chunk_index, $2 + 1), chunk_attempts = 0, updated_at = $3
         WHERE id = $1`,
        [input.run.runId, input.chunkIndex, input.now]);
      const queued = linked.rows.filter((row) => row.outcome === "queued").length;
      const result = { stopped, queued, decided: linked.rows.length - queued, notQueued: stopped ? 0 : leftover.rows.length };
      await insertRunAuditEvent(client, {
        vendorId: input.run.vendorId, storeConnectionId: input.run.storeConnectionId, runId: input.run.runId,
        eventType: "listing_push_run_chunk_queued", actor: SWEEP_ACTOR,
        severity: result.notQueued > 0 ? "error" : "info",
        payload: { chunkIndex: input.chunkIndex, jobId: input.jobId, ...result,
          notQueuedIds: stopped ? [] : leftover.rows.map((row) => row.product_variant_id) },
        now: input.now,
      });
      return result;
    });
  }

  async recordChunkFailure(input: {
    run: DropshipListingPushRunRecord; chunkIndex: number; failure: ListingPushRunChunkFailure; message: string; now: Date;
  }): Promise<{ attempts: number; decided: number; chunkJobExists: boolean }> {
    return this.inTransaction(async (client) => {
      const run = await client.query<{ chunk_attempts: number; status: string }>(
        `UPDATE dropship.dropship_listing_push_runs SET chunk_attempts = chunk_attempts + 1, updated_at = $2
         WHERE id = $1 RETURNING chunk_attempts, status`,
        [input.run.runId, input.now]);
      const attempts = run.rows[0]?.chunk_attempts ?? 0;
      // A job already carries this chunk (another expansion queued it): the next sweep adopts and records it, so its
      // sizes are never decided here, whatever the failure was (review MC5).
      const chunkJob = await client.query(
        "SELECT 1 FROM dropship.dropship_listing_push_jobs WHERE run_id = $1 AND run_chunk_index = $2",
        [input.run.runId, input.chunkIndex]);
      const decide = chunkJob.rows.length > 0 ? null : decideChunkFailure(input.failure, attempts);
      let decided = 0;
      if (decide) {
        const updated = await client.query(
          `UPDATE dropship.dropship_listing_push_run_targets
           SET outcome = $3, code = $4, retryable = $5, decided_at = $6
           WHERE run_id = $1 AND chunk_index = $2 AND outcome = 'pending'`,
          [input.run.runId, input.chunkIndex, decide.outcome, input.failure.code, decide.retryable, input.now]);
        decided = updated.rowCount ?? 0;
        await client.query(
          `UPDATE dropship.dropship_listing_push_runs
           SET next_chunk_index = GREATEST(next_chunk_index, $2 + 1), chunk_attempts = 0, updated_at = $3
           WHERE id = $1`,
          [input.run.runId, input.chunkIndex, input.now]);
      }
      await insertRunAuditEvent(client, {
        vendorId: input.run.vendorId, storeConnectionId: input.run.storeConnectionId, runId: input.run.runId,
        eventType: "listing_push_run_chunk_failed", actor: SWEEP_ACTOR,
        // A chunk whose job exists is retried every sweep: its audit row is an error once, at the attempt limit (review
        // round 2 MC3), and info otherwise.
        severity: decide
          ? (input.failure.kind === "conflict" || input.failure.kind === "permanent" ? "warning" : "error")
          : chunkJob.rows.length > 0 && attempts === RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS ? "error" : "info",
        payload: { chunkIndex: input.chunkIndex, kind: input.failure.kind, code: input.failure.code, message: input.message,
          attempts, decided, outcome: decide?.outcome ?? null, chunkJobExists: chunkJob.rows.length > 0 },
        now: input.now,
      });
      return { attempts, decided, chunkJobExists: chunkJob.rows.length > 0 };
    });
  }

  async recordChunkProductFailure(input: {
    run: DropshipListingPushRunRecord; chunkIndex: number; productId: number; code: string; message: string; now: Date;
  }): Promise<{ decided: number; chunkJobExists: boolean }> {
    return this.inTransaction(async (client) => {
      // The run first, as every run writer takes it; a stop that came first already cancelled what is pending.
      await client.query("SELECT id FROM dropship.dropship_listing_push_runs WHERE id = $1 FOR UPDATE", [input.run.runId]);
      // A job already carries this chunk: the next sweep adopts and records it, so nothing is decided here (review MC5).
      const chunkJob = await client.query(
        "SELECT 1 FROM dropship.dropship_listing_push_jobs WHERE run_id = $1 AND run_chunk_index = $2",
        [input.run.runId, input.chunkIndex]);
      if (chunkJob.rows.length > 0) return { decided: 0, chunkJobExists: true };
      const failed = await client.query<{ product_variant_id: number }>(
        `UPDATE dropship.dropship_listing_push_run_targets t
         SET outcome = 'failed', code = $4, retryable = false, decided_at = $5
         FROM catalog.product_variants pv
         WHERE t.run_id = $1 AND t.chunk_index = $2 AND t.outcome = 'pending'
           AND pv.id = t.product_variant_id AND pv.product_id = $3
         RETURNING t.product_variant_id`,
        [input.run.runId, input.chunkIndex, input.productId, input.code, input.now]);
      const productVariantIds = failed.rows.map((row) => row.product_variant_id).sort((left, right) => left - right);
      if (productVariantIds.length === 0) return { decided: 0, chunkJobExists: false };
      await advanceChunkWhenDecided(client, { runId: input.run.runId, chunkIndex: input.chunkIndex, now: input.now });
      await insertRunAuditEvent(client, {
        vendorId: input.run.vendorId, storeConnectionId: input.run.storeConnectionId, runId: input.run.runId,
        eventType: "listing_push_run_chunk_product_failed", actor: SWEEP_ACTOR, severity: "warning",
        payload: { chunkIndex: input.chunkIndex, productId: input.productId, code: input.code, message: input.message,
          failedTargets: { before: "pending", after: "failed", productVariantIds } },
        now: input.now,
      });
      return { decided: productVariantIds.length, chunkJobExists: false };
    });
  }

  async listRunsAwaitingNotice(input: { now: Date; windowMs: number; limit: number; problemLimit: number }): Promise<ListingPushRunFinished[]> {
    const runs = await this.dbPool.query<ListingPushRunRow>(
      `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
       WHERE r.notified_at IS NULL AND r.status <> 'processing'
         AND r.completed_at >= $1::timestamptz - make_interval(secs => $2::double precision / 1000)
       ORDER BY r.completed_at, r.id
       LIMIT $3`,
      [input.now, input.windowMs, input.limit]);
    const awaiting: ListingPushRunFinished[] = [];
    for (const row of runs.rows) {
      const run = mapListingPushRunRow(row);
      const counts = (await readRunCounts(this.dbPool, [run.runId])).get(run.runId) ?? countListingPushRunTargets([]);
      const store = await this.dbPool.query<{ external_display_name: string | null }>(
        "SELECT external_display_name FROM dropship.dropship_store_connections WHERE id = $1", [run.storeConnectionId]);
      awaiting.push({ run, counts, problems: await readProblems(this.dbPool, run.runId, input.problemLimit),
        storeName: store.rows[0]?.external_display_name ?? null,
        stockLinkFailuresNotRequeued: await readStockLinkFailuresNotRequeued(this.dbPool, run.runId) });
    }
    return awaiting;
  }

  async markRunNotified(input: { runId: number; now: Date }): Promise<void> {
    await this.dbPool.query(
      `UPDATE dropship.dropship_listing_push_runs SET notified_at = $2
       WHERE id = $1 AND notified_at IS NULL AND completed_at IS NOT NULL`,
      [input.runId, input.now]);
  }

  private async inTransaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** When a chunk's failed queue decides its pending targets (§4.3 step 5), and how. */
export function decideChunkFailure(failure: ListingPushRunChunkFailure, attempts: number): {
  outcome: "stale" | "failed"; retryable: boolean;
} | null {
  switch (failure.kind) {
    case "conflict": return attempts >= failure.maxAttempts ? { outcome: "stale", retryable: false } : null;
    case "key_conflict": return { outcome: "failed", retryable: false };
    case "permanent": return { outcome: "failed", retryable: false };
    case "transient": return attempts >= failure.maxAttempts ? { outcome: "failed", retryable: true } : null;
  }
}

/** Moves the run's chunk pointer past a chunk the pre-filter decided whole. */
async function advanceChunkWhenDecided(client: Queryable, input: { runId: number; chunkIndex: number; now: Date }): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_listing_push_runs r
     SET next_chunk_index = GREATEST(r.next_chunk_index, $2 + 1), chunk_attempts = 0, updated_at = $3
     WHERE r.id = $1 AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets t
                                     WHERE t.run_id = $1 AND t.chunk_index = $2 AND t.outcome = 'pending')`,
    [input.runId, input.chunkIndex, input.now]);
}

async function readProblems(client: Queryable, runId: number, limit: number): Promise<ListingPushRunProblem[]> {
  const result = await client.query<{
    product_variant_id: number; outcome: string; code: string | null; retryable: boolean | null; error_message: string | null;
    product_id: number | null; product_name: string | null; variant_name: string | null; sku: string | null;
  }>(
    `SELECT t.product_variant_id, t.outcome, t.code, t.retryable, i.error_message,
            pv.product_id, p.name AS product_name, pv.name AS variant_name, COALESCE(pv.sku, p.sku) AS sku
     FROM dropship.dropship_listing_push_run_targets t
     LEFT JOIN dropship.dropship_listing_push_job_items i ON i.id = t.job_item_id
     LEFT JOIN catalog.product_variants pv ON pv.id = t.product_variant_id
     LEFT JOIN catalog.products p ON p.id = pv.product_id
     WHERE t.run_id = $1 AND t.outcome = ANY($2::text[])
     ORDER BY t.product_variant_id
     LIMIT $3`,
    [runId, [...LISTING_PUSH_RUN_PROBLEM_OUTCOMES], limit]);
  return result.rows.map((row) => ({
    productVariantId: row.product_variant_id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    outcome: row.outcome as ListingPushRunProblemOutcome,
    code: row.code,
    message: row.error_message,
    retryable: row.retryable,
  }));
}

/**
 * The run's failed sizes per stock link code the sweep re-queues outside a run and never for one (merge review
 * ADV-RB2-1), by code. Reads only this run's targets (its primary key's leading column).
 */
async function readStockLinkFailuresNotRequeued(client: Queryable, runId: number): Promise<ListingPushRunCodeCount[]> {
  const result = await client.query<{ code: string; count: number }>(
    `SELECT t.code, count(*)::int AS count
     FROM dropship.dropship_listing_push_run_targets t
     WHERE t.run_id = $1 AND t.outcome = 'failed' AND t.code = ANY($2::text[])
     GROUP BY t.code
     ORDER BY t.code`,
    [runId, [...RUN_UNREQUEUED_STOCK_LINK_CODES]]);
  return result.rows.map((row) => ({ code: row.code, count: row.count }));
}

async function rollbackQuietly(client: Queryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is the one the caller needs; a failed rollback leaves nothing committed.
  }
}
