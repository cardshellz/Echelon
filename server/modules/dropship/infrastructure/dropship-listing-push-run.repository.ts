import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  LISTING_PUSH_RUN_ERROR_CODES,
  LISTING_PUSH_RUN_PROBLEM_OUTCOMES,
  type ListingPushRunCounts,
  type ListingPushRunProblem,
  type ListingPushRunProblemOutcome,
} from "../../../../shared/dropship/listing-push-runs";
import type {
  CreateListingPushRunRepositoryInput,
  DropshipListingPushRunRecord,
  DropshipListingPushRunRepository,
} from "../application/dropship-listing-push-run-service";
import { loadSelectedVariantIds } from "../application/dropship-selected-catalog";
import { DropshipError } from "../domain/errors";
import {
  LISTING_PUSH_RUN_CODES,
  LIVE_LISTING_STATUSES,
  assignListingPushRunChunks,
  countListingPushRunTargets,
  listingPushRunChunkCount,
} from "../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS } from "../domain/listing-push-run-words";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { cancelQueuedRunItems, restoreListingsOfCancelledItems } from "./dropship-listing-push-run-items";
import { lockVendorSelection } from "./dropship-vendor-selection-lock";

/**
 * How long a run create waits for the vendor's selection lock (or any row it
 * locks) before it answers "busy, try again" (§4.2): a selection save holds
 * that lock for its whole transaction.
 */
export const LISTING_PUSH_RUN_CREATE_LOCK_TIMEOUT = "5s";

/** The constraint that keeps one unfinished run per store (the migration's partial unique index). */
const ONE_ACTIVE_RUN_INDEX = "dropship_push_run_one_active_idx";

export interface ListingPushRunRow {
  id: string | number;
  vendor_id: number;
  store_connection_id: number;
  scope: string;
  status: string;
  stop_reason: string | null;
  selection_revision_id: number | null;
  idempotency_key: string;
  request_hash: string;
  target_count: number;
  chunk_size: number;
  chunk_count: number;
  next_chunk_index: number;
  chunk_attempts: number;
  actor_type: string;
  actor_id: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/** The run columns every reader selects, in one place so a column added to the table is read everywhere. */
export const LISTING_PUSH_RUN_COLUMNS = `r.id, r.vendor_id, r.store_connection_id, r.scope, r.status, r.stop_reason,
  r.selection_revision_id, r.idempotency_key, r.request_hash, r.target_count, r.chunk_size, r.chunk_count,
  r.next_chunk_index, r.chunk_attempts, r.actor_type, r.actor_id, r.cancel_requested_at, r.created_at, r.updated_at,
  r.completed_at`;

type Queryable = Pick<PoolClient, "query">;

export class PgDropshipListingPushRunRepository implements DropshipListingPushRunRepository {
  constructor(private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool) {}

  async findVendorIdByMemberId(memberId: string): Promise<number | null> {
    const result = await this.dbPool.query<{ id: number }>(
      "SELECT id FROM dropship.dropship_vendors WHERE member_id::text = $1 LIMIT 1", [memberId]);
    return result.rows[0]?.id ?? null;
  }

  async findRunByKey(input: { vendorId: number; idempotencyKey: string }): Promise<DropshipListingPushRunRecord | null> {
    const found = await this.dbPool.query<ListingPushRunRow>(
      `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
       WHERE r.vendor_id = $1 AND r.idempotency_key = $2`,
      [input.vendorId, input.idempotencyKey]);
    return found.rows[0] ? mapListingPushRunRow(found.rows[0]) : null;
  }

  async createRun(input: CreateListingPushRunRepositoryInput): Promise<{ run: DropshipListingPushRunRecord; idempotentReplay: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // A selection save holds the vendor lock for its whole transaction; a run waits a little, then says busy.
      await client.query(`SET LOCAL lock_timeout = '${LISTING_PUSH_RUN_CREATE_LOCK_TIMEOUT}'`);
      await lockVendorSelection(client, input.vendorId);

      const existing = await client.query<ListingPushRunRow>(
        `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
         WHERE r.vendor_id = $1 AND r.idempotency_key = $2 FOR UPDATE`,
        [input.vendorId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== input.requestHash) {
          throw new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.idempotencyConflict,
            LISTING_PUSH_RUN_WORDS.keyReused,
            { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, classification: "permanent" });
        }
        await client.query("COMMIT");
        return { run: mapListingPushRunRow(existing.rows[0]), idempotentReplay: true };
      }

      const head = await readHeadSelectionRevisionId(client, input.vendorId);
      if (head !== input.expectedSelectionRevisionId) {
        throw new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict,
          LISTING_PUSH_RUN_WORDS.selectionChanged,
          { expectedSelectionRevisionId: input.expectedSelectionRevisionId, currentSelectionRevisionId: head,
            classification: "permanent" });
      }

      // The server's own snapshot of the selection at that revision (D10): the vendor lock keeps it from moving.
      const selectedIds = await loadSelectedVariantIds(
        selectedCatalogReaderForTransaction(client, input.vendorId), input.now, "listing_push_run");
      const liveIds = input.scope === "not_live"
        ? await listLiveVariantIds(client, { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, productVariantIds: selectedIds })
        : new Set<number>();
      const targetIds = selectedIds.filter((id) => !liveIds.has(id));
      if (targetIds.length === 0) {
        throw new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.empty,
          input.scope === "not_live" && liveIds.size > 0 ? LISTING_PUSH_RUN_WORDS.runEmptyNew : LISTING_PUSH_RUN_WORDS.runEmpty,
          { scope: input.scope, liveCount: liveIds.size, selectedCount: selectedIds.length, classification: "permanent" });
      }

      // One unfinished run per store (the partial unique index is the backstop; this names the run to show).
      const active = await client.query<{ id: string | number }>(
        `SELECT id FROM dropship.dropship_listing_push_runs
         WHERE store_connection_id = $1 AND status = 'processing' ORDER BY id LIMIT 1`,
        [input.storeConnectionId]);
      if (active.rows[0]) throw runActive(toRunId(active.rows[0].id));

      const chunkCount = listingPushRunChunkCount(targetIds.length, input.chunkSize);
      const inserted = await insertRun(client, { ...input, selectionRevisionId: head, targetCount: targetIds.length, chunkCount });
      const run = mapListingPushRunRow(inserted);
      const chunks = assignListingPushRunChunks(targetIds, input.chunkSize);
      // Set-based: one statement for up to 10,000 targets, each size in exactly one chunk, in id order.
      await client.query(
        `INSERT INTO dropship.dropship_listing_push_run_targets (run_id, product_variant_id, chunk_index, outcome)
         SELECT $1, target.product_variant_id, target.chunk_index, 'pending'
         FROM unnest($2::int[], $3::int[]) AS target(product_variant_id, chunk_index)`,
        [run.runId, chunks.map((chunk) => chunk.productVariantId), chunks.map((chunk) => chunk.chunkIndex)]);
      await insertRunAuditEvent(client, {
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, runId: run.runId,
        eventType: "listing_push_run_created", actor: input.actor,
        payload: {
          idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, scope: input.scope,
          selectionRevisionId: head, targetCount: targetIds.length, chunkSize: input.chunkSize, chunkCount,
          selectedCount: selectedIds.length, liveExcludedCount: liveIds.size, targetIds,
        },
        now: input.now,
      });
      await client.query("COMMIT");
      return { run, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapCreateRunError(error, input);
    } finally {
      client.release();
    }
  }

  async listRuns(input: { vendorId: number; storeConnectionId: number; limit: number }): Promise<Array<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts;
  }>> {
    const runs = await this.dbPool.query<ListingPushRunRow>(
      `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
       WHERE r.vendor_id = $1 AND r.store_connection_id = $2
       ORDER BY r.id DESC LIMIT $3`,
      [input.vendorId, input.storeConnectionId, input.limit]);
    const records = runs.rows.map(mapListingPushRunRow);
    const counts = await readRunCounts(this.dbPool, records.map((run) => run.runId));
    return records.map((run) => ({ run, counts: counts.get(run.runId) ?? countListingPushRunTargets([]) }));
  }

  async getRun(input: { vendorId: number; runId: number; problemsAfter: number; problemsLimit: number; now: Date }): Promise<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts; problems: ListingPushRunProblem[]; hasMoreProblems: boolean;
    waitingUntil: Date | null; drafts: number;
  } | null> {
    const found = await this.dbPool.query<ListingPushRunRow>(
      `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
       WHERE r.id = $1 AND r.vendor_id = $2`,
      [input.runId, input.vendorId]);
    if (!found.rows[0]) return null;
    const run = mapListingPushRunRow(found.rows[0]);
    const counts = (await readRunCounts(this.dbPool, [run.runId])).get(run.runId) ?? countListingPushRunTargets([]);
    const problems = await this.dbPool.query<ProblemRow>(
      `SELECT t.product_variant_id, t.outcome, t.code, t.retryable, i.error_message,
              pv.product_id, p.name AS product_name, pv.name AS variant_name, COALESCE(pv.sku, p.sku) AS sku
       FROM dropship.dropship_listing_push_run_targets t
       LEFT JOIN dropship.dropship_listing_push_job_items i ON i.id = t.job_item_id
       LEFT JOIN catalog.product_variants pv ON pv.id = t.product_variant_id
       LEFT JOIN catalog.products p ON p.id = pv.product_id
       WHERE t.run_id = $1 AND t.outcome = ANY($2::text[]) AND t.product_variant_id > $3
       ORDER BY t.product_variant_id
       LIMIT $4`,
      [run.runId, [...LISTING_PUSH_RUN_PROBLEM_OUTCOMES], input.problemsAfter, input.problemsLimit + 1]);
    const rows = problems.rows.slice(0, input.problemsLimit);
    // A paused chunk job (eBay busy, §4.5) and the sizes a draft-first store saved unpublished (rawResult.published,
    // the eBay provider's answer): what the page says beside the counts (review DUX5, DUX7). Two indexed reads.
    const progress = await this.dbPool.query<{ waiting_until: Date | null; drafts: number }>(
      `SELECT (SELECT max(j.next_attempt_at) FROM dropship.dropship_listing_push_jobs j
               WHERE j.run_id = $1 AND j.status = 'queued' AND j.next_attempt_at > $2) AS waiting_until,
              (SELECT count(*)::int FROM dropship.dropship_listing_push_run_targets t
               JOIN dropship.dropship_listing_push_job_items i ON i.id = t.job_item_id
               WHERE t.run_id = $1 AND t.outcome = 'completed'
                 AND i.result->'push'->'rawResult'->>'published' = 'false') AS drafts`,
      [run.runId, input.now]);
    return {
      run, counts, problems: rows.map(mapProblemRow), hasMoreProblems: problems.rows.length > input.problemsLimit,
      waitingUntil: progress.rows[0]?.waiting_until ?? null, drafts: progress.rows[0]?.drafts ?? 0,
    };
  }

  async stopRun(input: { vendorId: number; runId: number; actor: CreateListingPushRunRepositoryInput["actor"]; now: Date }): Promise<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts; changed: boolean;
  } | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<ListingPushRunRow>(
        `SELECT ${LISTING_PUSH_RUN_COLUMNS} FROM dropship.dropship_listing_push_runs r
         WHERE r.id = $1 AND r.vendor_id = $2 FOR UPDATE`,
        [input.runId, input.vendorId]);
      if (!found.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const before = mapListingPushRunRow(found.rows[0]);
      if (before.status !== "processing" || before.cancelRequestedAt !== null) {
        // Idempotent by state: a run already stopping or finished is answered as it is.
        const counts = (await readRunCounts(client, [before.runId])).get(before.runId) ?? countListingPushRunTargets([]);
        await client.query("COMMIT");
        return { run: before, counts, changed: false };
      }
      const updated = await client.query<ListingPushRunRow>(
        `UPDATE dropship.dropship_listing_push_runs AS r
         SET cancel_requested_at = $2, stop_reason = COALESCE(r.stop_reason, 'vendor_stop'), updated_at = $2
         WHERE r.id = $1
         RETURNING ${LISTING_PUSH_RUN_COLUMNS}`,
        [before.runId, input.now]);
      const cancelled = await cancelRunWork(client, { runId: before.runId, now: input.now });
      const counts = (await readRunCounts(client, [before.runId])).get(before.runId) ?? countListingPushRunTargets([]);
      await insertRunAuditEvent(client, {
        vendorId: before.vendorId, storeConnectionId: before.storeConnectionId, runId: before.runId,
        eventType: "listing_push_run_stop_requested", actor: input.actor,
        payload: { cancelledPendingTargets: cancelled.pendingTargets, cancelledQueuedItems: cancelled.queuedItems,
          keptInFlightItems: cancelled.keptInFlightItems, restoredListings: cancelled.restoredListings, counts },
        now: input.now,
      });
      await client.query("COMMIT");
      return { run: mapListingPushRunRow(requiredRow(updated.rows[0], "Publish run stop did not return the run.")), counts, changed: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface ProblemRow {
  product_variant_id: number;
  outcome: string;
  code: string | null;
  retryable: boolean | null;
  error_message: string | null;
  product_id: number | null;
  product_name: string | null;
  variant_name: string | null;
  sku: string | null;
}

/**
 * The vendor's head selection revision: the newest saved selection (every
 * save writes one revision row, F1), or null when the vendor never saved one.
 * The run create, and the selection summary the page counts from, read the
 * same value.
 */
export async function readHeadSelectionRevisionId(client: Queryable, vendorId: number): Promise<number | null> {
  const result = await client.query<{ id: number | null }>(
    "SELECT max(id) AS id FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = $1", [vendorId]);
  return result.rows[0]?.id ?? null;
}

/**
 * The sizes live on the store now: a live status and an eBay listing id. The
 * run create reads it over its snapshot ids; the selection summary (§4.8) over
 * the whole store (no ids), so "Publish {n} new" counts what `not_live` sends.
 */
export async function listLiveVariantIds(client: Queryable, input: {
  vendorId: number; storeConnectionId: number; productVariantIds?: readonly number[];
}): Promise<Set<number>> {
  if (input.productVariantIds !== undefined && input.productVariantIds.length === 0) return new Set();
  const result = await client.query<{ product_variant_id: number }>(
    `SELECT product_variant_id FROM dropship.dropship_vendor_listings
     WHERE vendor_id = $1 AND store_connection_id = $2
       AND ($3::int[] IS NULL OR product_variant_id = ANY($3::int[]))
       AND status = ANY($4::text[]) AND NULLIF(BTRIM(external_listing_id), '') IS NOT NULL`,
    [input.vendorId, input.storeConnectionId, input.productVariantIds ?? null, [...LIVE_LISTING_STATUSES]]);
  return new Set(result.rows.map((row) => row.product_variant_id));
}

async function insertRun(client: Queryable, input: CreateListingPushRunRepositoryInput & {
  selectionRevisionId: number | null; targetCount: number; chunkCount: number;
}): Promise<ListingPushRunRow> {
  const result = await client.query<ListingPushRunRow>(
    `INSERT INTO dropship.dropship_listing_push_runs AS r
      (vendor_id, store_connection_id, scope, status, selection_revision_id, idempotency_key, request_hash,
       target_count, chunk_size, chunk_count, actor_type, actor_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING ${LISTING_PUSH_RUN_COLUMNS}`,
    [input.vendorId, input.storeConnectionId, input.scope, input.selectionRevisionId, input.idempotencyKey,
      input.requestHash, input.targetCount, input.chunkSize, input.chunkCount, input.actor.actorType,
      input.actor.actorId ?? null, input.now]);
  return requiredRow(result.rows[0], "Publish run insert did not return the run.");
}

/**
 * A stop's writes (§4.6, SAFETY7): every pending target is cancelled, and
 * every queued item of the run's jobs, so the guarded claim of an item
 * (markItemProcessing: AND status = 'queued') never starts one. An item
 * already processing finishes, and so does a queued one whose last send's
 * outcome on eBay is unknown (verify V2: a dead worker's size that stale
 * recovery queued again); its target stays queued until it does. A cancelled
 * item's listing goes back to its status before the queue (verify V7).
 */
export async function cancelRunWork(client: Queryable, input: { runId: number; now: Date }): Promise<{
  pendingTargets: number[]; queuedItems: number[]; keptInFlightItems: number[]; restoredListings: number[];
}> {
  const pending = await client.query<{ product_variant_id: number }>(
    `UPDATE dropship.dropship_listing_push_run_targets
     SET outcome = 'cancelled', code = $2, retryable = false, decided_at = $3
     WHERE run_id = $1 AND outcome = 'pending'
     RETURNING product_variant_id`,
    [input.runId, LISTING_PUSH_RUN_CODES.stopped, input.now]);
  const items = await cancelQueuedRunItems(client, { runId: input.runId, now: input.now });
  const itemIds = items.cancelled;
  const restored = await restoreListingsOfCancelledItems(client, { itemIds, source: "dropship_listing_push_stop", now: input.now });
  if (itemIds.length > 0) {
    // The same values the reconcile copies from a cancelled item (no push outcome, so no retry class), so it
    // finds nothing to change later.
    await client.query(
      `UPDATE dropship.dropship_listing_push_run_targets
       SET outcome = 'cancelled', code = $2, retryable = NULL, decided_at = $3
       WHERE run_id = $1 AND job_item_id = ANY($4::int[]) AND outcome = 'queued'`,
      [input.runId, LISTING_PUSH_RUN_CODES.stopped, input.now, itemIds]);
  }
  return { pendingTargets: pending.rows.map((row) => row.product_variant_id), queuedItems: itemIds,
    keptInFlightItems: items.keptInFlight, restoredListings: restored.map((row) => row.listingId) };
}


/** Counts by outcome for each run, read live from its targets (§4.4: counts are never stored). */
export async function readRunCounts(client: Queryable, runIds: readonly number[]): Promise<Map<number, ListingPushRunCounts>> {
  const counts = new Map<number, ListingPushRunCounts>();
  if (runIds.length === 0) return counts;
  const result = await client.query<{ run_id: string | number; outcome: string; count: string | number }>(
    `SELECT run_id, outcome, COUNT(*) AS count FROM dropship.dropship_listing_push_run_targets
     WHERE run_id = ANY($1::bigint[]) GROUP BY run_id, outcome`,
    [runIds]);
  const byRun = new Map<number, Array<{ outcome: string; count: number }>>();
  for (const row of result.rows) {
    const runId = toRunId(row.run_id);
    const list = byRun.get(runId) ?? [];
    list.push({ outcome: row.outcome, count: Number(row.count) });
    byRun.set(runId, list);
  }
  for (const runId of runIds) counts.set(runId, countListingPushRunTargets(byRun.get(runId) ?? []));
  return counts;
}

export async function insertRunAuditEvent(client: Queryable, input: {
  vendorId: number;
  storeConnectionId: number;
  runId: number;
  eventType: string;
  actor: { actorType: string; actorId?: string | null };
  severity?: "info" | "warning" | "error";
  payload: Record<string, unknown>;
  now: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_push_run', $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [input.vendorId, input.storeConnectionId, String(input.runId), input.eventType, input.actor.actorType,
      input.actor.actorId ?? null, input.severity ?? "info", JSON.stringify({ runId: input.runId, ...input.payload }), input.now]);
}

export function mapListingPushRunRow(row: ListingPushRunRow): DropshipListingPushRunRecord {
  return {
    runId: toRunId(row.id),
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    scope: row.scope as DropshipListingPushRunRecord["scope"],
    status: row.status as DropshipListingPushRunRecord["status"],
    stopReason: row.stop_reason as DropshipListingPushRunRecord["stopReason"],
    selectionRevisionId: row.selection_revision_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    targetCount: row.target_count,
    chunkSize: row.chunk_size,
    chunkCount: row.chunk_count,
    nextChunkIndex: row.next_chunk_index,
    chunkAttempts: row.chunk_attempts,
    actorType: row.actor_type as DropshipListingPushRunRecord["actorType"],
    actorId: row.actor_id,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** A run id from the database: bigint arrives as text; it must be a whole number JavaScript holds exactly. */
export function toRunId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid publish run id: ${String(value)}`);
  return id;
}

function mapProblemRow(row: ProblemRow): ListingPushRunProblem {
  return {
    productVariantId: row.product_variant_id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    outcome: row.outcome as ListingPushRunProblemOutcome,
    code: row.code,
    message: row.error_message,
    retryable: row.retryable,
  };
}

function runActive(runId: number | null): DropshipError {
  return new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.runActive,
    LISTING_PUSH_RUN_WORDS.runActive, { runId, classification: "permanent" });
}

/**
 * A lock timeout (55P03) is a selection save holding the vendor lock: transient,
 * the page retries with the same key. The one-active index's violation is a
 * second press that raced past the read above. Anything else is the caller's.
 */
function mapCreateRunError(error: unknown, input: CreateListingPushRunRepositoryInput): unknown {
  const pgError = error as { code?: unknown; constraint?: unknown };
  if (pgError?.code === "55P03") {
    return new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.busy,
      LISTING_PUSH_RUN_WORDS.runBusy,
      { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, retryable: true, classification: "transient" });
  }
  if (pgError?.code === "23505" && pgError.constraint === ONE_ACTIVE_RUN_INDEX) return runActive(null);
  return error;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

async function rollbackQuietly(client: Queryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is the one the caller needs; a failed rollback leaves nothing committed.
  }
}
