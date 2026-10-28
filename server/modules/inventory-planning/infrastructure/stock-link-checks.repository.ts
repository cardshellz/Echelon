import type { Pool } from "pg";
import { z } from "zod";
import { stockLinkCheckStatusSchema, stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import type { StockLinkRecentCursor } from "../application/stock-link.ports";
import type { StockLinkCheckFacts, StockLinkCheckWrite } from "../domain/stock-link-check-outcome";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../domain/stock-link-errors";
import { stockLinkRetiresWithoutReplacementCountText } from "./stock-link-health.sql";

/**
 * The stock-link check rows and destination state (inventory.stock_link_checks / stock_link_destinations, M1)
 * (channels PR2, PLAN-CH2 v4.1 §4.3 steps 3, 4, 10, §4.6, §7.2). Inventory planning owns both tables.
 * - Command side: the claim re-check under row locks, the per-destination switch, the engine's command receipt, the
 *   rows' outcomes and the freed-item wake. Every row write is guarded by the claim's lease token and revision, so a
 *   row the claim no longer owns is never written.
 * - Tick side (§7.2): the destinations to look after, the heartbeat, discovery (new rows, woken rows, rows of sizes no
 *   longer carried), the dead-letter scan, the claim, the facts a decision reads, the retire count, pause and halt.
 *   Each write is one short transaction under a 5 s lock timeout, never across a provider call.
 * The controls (switch, Continue, Check again) are in stock-link-controls.repository.ts.
 */

type Queryable = { query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]):
  Promise<{ rows: Row[]; rowCount: number | null }> };

/** The receipt's command type in public.idempotency_keys.response_body (key `stock-link:<commandKey>`, §4.3 step 3). */
export const STOCK_LINK_RECEIPT_COMMAND_TYPE = "stock_link_command";

/** One claimed check row as the tick holds it (§7.2 step 4): its lease token and the revision the claim wrote. */
export interface StockLinkCheckClaim {
  readonly productVariantId: number;
  readonly leaseToken: string;
  readonly revision: string;
}

/** The guard of one row's write: the claim, or the state a committed command left (lease cleared, revision + 1). */
export interface StockLinkCheckGuard {
  readonly productVariantId: number;
  readonly leaseToken: string | null;
  readonly revision: string;
}

export interface LockedStockLinkCheck extends StockLinkCheckFacts {
  readonly productVariantId: number;
  readonly revision: string;
}

const checkRowSchema = z.object({
  product_variant_id: z.coerce.number().int().positive(),
  status: stockLinkCheckStatusSchema,
  reason_code: z.string().nullable(),
  attempt_count: z.coerce.number().int().nonnegative(),
  first_failure_at: z.date().nullable(),
  busy_since: z.date().nullable(),
  next_check_at: z.date().nullable(),
  updated_at: z.date(),
  waiting_item_id: z.string().nullable(),
  observed_sku: z.string().nullable(),
  revision: z.string().regex(/^[1-9]\d*$/),
  lease_token: z.string().nullable(),
});

const CHECK_COLUMNS = `product_variant_id, status, reason_code, attempt_count, first_failure_at, busy_since, next_check_at,
  updated_at, waiting_item_id, observed_sku, revision::text AS revision, lease_token::text AS lease_token`;

function lockedCheck(raw: unknown): LockedStockLinkCheck & { leaseToken: string | null } {
  const row = checkRowSchema.parse(raw);
  return { productVariantId: row.product_variant_id, status: row.status, reasonCode: row.reason_code,
    attemptCount: row.attempt_count, firstFailureAt: row.first_failure_at, busySince: row.busy_since,
    nextCheckAt: row.next_check_at, updatedAt: row.updated_at, waitingItemId: row.waiting_item_id,
    observedSku: row.observed_sku, revision: row.revision, leaseToken: row.lease_token };
}

/**
 * Step 4: the claimed rows FOR UPDATE, each still holding the claim's lease token at the claim's revision. Any other
 * state means the claim was lost (its lease expired and another tick took the row, or a control changed it):
 * transient STOCK_LINK_CLAIM_LOST, nothing written.
 */
export async function lockClaimedStockLinkChecks(client: Queryable, publicationTargetId: number,
  claims: readonly StockLinkCheckClaim[]): Promise<LockedStockLinkCheck[]> {
  const variantIds = claims.map(claim => claim.productVariantId).sort((a, b) => a - b);
  const rows = (await client.query(`SELECT ${CHECK_COLUMNS} FROM inventory.stock_link_checks
    WHERE publication_target_id = $1 AND product_variant_id = ANY($2::integer[])
    ORDER BY product_variant_id FOR UPDATE`, [publicationTargetId, variantIds])).rows.map(lockedCheck);
  const byVariant = new Map(rows.map(row => [row.productVariantId, row]));
  for (const claim of claims) {
    const row = byVariant.get(claim.productVariantId);
    if (!row || row.leaseToken !== claim.leaseToken || row.revision !== claim.revision) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.claimLost,
        "The size's check was claimed again or changed; it is decided again on the next check.",
        { publicationTargetId, productVariantId: claim.productVariantId });
    }
  }
  return variantIds.map(variantId => {
    const { leaseToken: _lease, ...row } = byVariant.get(variantId)!;
    return row;
  });
}

export interface StockLinkDestinationSwitch {
  readonly autoLinkEnabled: boolean;
  readonly haltedAt: Date | null;
  readonly haltedCode: string | null;
}

/** Step 4: the destination row FOR SHARE (a control that turns the switch off waits for this command, and the
 * command sees a switch turned off before it). Null when the tick never set the destination up. */
export async function readStockLinkDestinationSwitch(client: Queryable, publicationTargetId: number):
  Promise<StockLinkDestinationSwitch | null> {
  const row = (await client.query<{ auto_link_enabled: boolean; halted_at: Date | null; halted_code: string | null }>(
    `SELECT auto_link_enabled, halted_at, halted_code FROM inventory.stock_link_destinations
     WHERE publication_target_id = $1 FOR SHARE`, [publicationTargetId])).rows[0];
  return row ? { autoLinkEnabled: row.auto_link_enabled === true, haltedAt: row.halted_at, haltedCode: row.halted_code } : null;
}

export interface StockLinkReceipt {
  readonly requestHash: string;
  readonly responseBody: unknown;
}

/** The engine's own receipt (§4.3 step 3, step 10); the command lock serializes its writers. */
export async function readStockLinkReceipt(client: Queryable, key: string): Promise<StockLinkReceipt | null> {
  const row = (await client.query<{ request_hash: string; response_body: unknown }>(
    "SELECT request_hash, response_body FROM public.idempotency_keys WHERE key = $1", [key])).rows[0];
  return row ? { requestHash: row.request_hash, responseBody: row.response_body } : null;
}

export async function insertStockLinkReceipt(client: Queryable, input: { key: string; requestHash: string; now: Date;
  result: unknown }): Promise<void> {
  await client.query(`INSERT INTO public.idempotency_keys(key, request_hash, response_body, created_at, expires_at)
    VALUES($1, $2, $3::jsonb, $4, NULL)`,
  [input.key, input.requestHash, JSON.stringify({ commandType: STOCK_LINK_RECEIPT_COMMAND_TYPE, result: input.result }), input.now]);
}

/**
 * Writes each row's outcome and ends its lease (revision + 1), guarded by `guard`. Returns the variant ids written.
 * `strict`: every row must be written (the command holds them FOR UPDATE), else the claim was lost.
 */
export async function writeStockLinkCheckOutcomes(client: Queryable, publicationTargetId: number,
  writes: readonly { guard: StockLinkCheckGuard; write: StockLinkCheckWrite }[], now: Date, strict: boolean): Promise<number[]> {
  const written: number[] = [];
  for (const { guard, write } of [...writes].sort((a, b) => a.guard.productVariantId - b.guard.productVariantId)) {
    const result = await client.query(`UPDATE inventory.stock_link_checks
      SET status = $4, reason_code = $5, error_class = $6, message = $7, attempt_count = $8, first_failure_at = $9,
          busy_since = $10, next_check_at = $11, waiting_item_id = $12, observed_sku = $13,
          lease_token = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = $14
      WHERE publication_target_id = $1 AND product_variant_id = $2 AND revision = $3::bigint
        AND lease_token IS NOT DISTINCT FROM $15::uuid`,
    [publicationTargetId, guard.productVariantId, guard.revision, write.status, write.reasonCode, write.errorClass,
      write.message, write.attemptCount, write.firstFailureAt, write.busySince, write.nextCheckAt, write.waitingItemId,
      write.observedSku, now, guard.leaseToken]);
    if (result.rowCount === 1) written.push(guard.productVariantId);
    else if (strict) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.claimLost,
        "The size's check was claimed again or changed; it is decided again on the next check.",
        { publicationTargetId, productVariantId: guard.productVariantId });
    }
  }
  return written;
}

/**
 * SAF-5 wake (§4.3 step 10): rows of the destination waiting on an item this command freed (F4 ITEM_HELD,
 * WAITING_FOR_FREED_ITEM) are due now. Rows another claim holds are left to their claim; stopped rows wait for a
 * person. An early wake restarts the wait's backoff (updated_at = next_check_at). Returns the rows woken.
 */
export async function wakeStockLinkChecksWaitingOn(client: Queryable, publicationTargetId: number,
  itemIds: readonly string[], now: Date): Promise<number[]> {
  if (itemIds.length === 0) return [];
  const rows = (await client.query<{ product_variant_id: number }>(`UPDATE inventory.stock_link_checks
    SET next_check_at = $3, updated_at = $3, revision = revision + 1
    WHERE publication_target_id = $1 AND waiting_item_id = ANY($2::text[]) AND status <> 'error'
      AND lease_token IS NULL AND next_check_at > $3
    RETURNING product_variant_id`, [publicationTargetId, [...new Set(itemIds)].sort(), now])).rows;
  return rows.map(row => Number(row.product_variant_id)).sort((a, b) => a - b);
}

/** Every tick-side write waits at most this long for a row lock: a lock held elsewhere is another writer's short
 * transaction (a control, a feed writer's catalog row), and 55P03 makes the step busy, never a blocked tick. */
const SHORT_TRANSACTION_LOCK_TIMEOUT = "5s";

/**
 * One short READ COMMITTED transaction on its own connection, under the lock timeout. A failed rollback leaves the
 * connection's state unknown: it is discarded and the failure is an AggregateError (STOCK_LINK_ROLLBACK_FAILED, fatal).
 */
export async function inShortStockLinkTransaction<T>(pool: Pick<Pool, "connect">, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(`SET LOCAL lock_timeout = '${SHORT_TRANSACTION_LOCK_TIMEOUT}'`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error, rollbackError], "A stock-link write and its rollback failed.");
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/**
 * Outside a command's transaction (its fast path, a replay, a failure): lock the guarded rows, let `decide` compute
 * each one's outcome from the row as locked, and write it, in one short transaction. Rows whose guard no longer
 * matches are skipped (the claim was lost; another tick owns them). Returns the variant ids written.
 */
export async function recordStockLinkCheckOutcomes(pool: Pick<Pool, "connect">, publicationTargetId: number,
  guards: readonly StockLinkCheckGuard[], now: Date,
  decide: (productVariantId: number, previous: LockedStockLinkCheck) => StockLinkCheckWrite): Promise<number[]> {
  if (guards.length === 0) return [];
  // The rows are this claim's; a lock held elsewhere is another writer's short transaction, never a provider call.
  return inShortStockLinkTransaction(pool, async client => {
    const variantIds = guards.map(guard => guard.productVariantId);
    const rows = (await client.query(`SELECT ${CHECK_COLUMNS} FROM inventory.stock_link_checks
      WHERE publication_target_id = $1 AND product_variant_id = ANY($2::integer[])
      ORDER BY product_variant_id FOR UPDATE`, [publicationTargetId, variantIds])).rows.map(lockedCheck);
    const writes = [];
    for (const guard of guards) {
      const row = rows.find(candidate => candidate.productVariantId === guard.productVariantId);
      if (!row || row.leaseToken !== guard.leaseToken || row.revision !== guard.revision) continue;
      const { leaseToken: _lease, ...previous } = row;
      writes.push({ guard, write: decide(guard.productVariantId, previous) });
    }
    return writeStockLinkCheckOutcomes(client, publicationTargetId, writes, now, true);
  });
}

// ---------------------------------------------------------------------------
// Tick side (§7.2)
// ---------------------------------------------------------------------------

/** The runtime authority (the tick idles under legacy authority, as every link writer requires canonical). */
export async function readStockLinkRuntimeAuthority(pool: Pick<Pool, "query">): Promise<"legacy" | "canonical"> {
  const rows = (await pool.query<{ authority: unknown }>(
    "SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key = true")).rows;
  const parsed = z.enum(["legacy", "canonical"]).safeParse(rows[0]?.authority);
  if (rows.length !== 1 || !parsed.success) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "The runtime publication authority is unavailable.", {});
  }
  return parsed.data;
}

/** One live, Echelon-managed publication target, as the destination the engine decides for (§7.2). */
export interface StockLinkTargetRow {
  readonly publicationTargetId: number;
  /** Null when the row is not a destination the engine can describe (the tick skips it at DEBUG). */
  readonly destination: StockLinkDestination | null;
  readonly destinationKind: string;
  readonly providerKey: string;
  /** The target's own hold: nothing publishes while it is held, so nothing is linked either. */
  readonly heldAt: Date | null;
}

const targetRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  destination_kind: z.string(),
  provider_key: z.string().nullable(),
  channel_id: z.coerce.number().int().positive(),
  channel_connection_id: z.coerce.number().int().positive().nullable(),
  dropship_store_connection_id: z.coerce.number().int().positive().nullable(),
  provider_scope_type: z.string(),
  external_scope_id: z.string(),
  revision: z.string(),
  held_at: z.date().nullable(),
});

/**
 * Every live target with Echelon publication authority, in id order. The provider key is the one the command's locked
 * target read names (publication-mapping-preparation.repository.ts readTargets), so the two always agree.
 */
export async function listStockLinkTargets(pool: Pick<Pool, "query">): Promise<StockLinkTargetRow[]> {
  const rows = (await pool.query(`SELECT t.id, t.destination_kind,
      CASE t.destination_kind WHEN 'channel_connection' THEN c.provider ELSE lower(d.platform) END AS provider_key,
      t.channel_id, t.channel_connection_id, t.dropship_store_connection_id, t.provider_scope_type, t.external_scope_id,
      t.revision::text AS revision, t.held_at
    FROM inventory.inventory_publication_targets t
    JOIN channels.channels c ON c.id = t.channel_id
    LEFT JOIN dropship.dropship_store_connections d ON d.id = t.dropship_store_connection_id
    WHERE t.state = 'live' AND t.publication_authority = 'echelon'
    ORDER BY t.id`)).rows.map(raw => targetRowSchema.parse(raw));
  return rows.map(row => {
    const destination = stockLinkDestinationSchema.safeParse({ publicationTargetId: row.id, destinationKind: row.destination_kind,
      providerKey: row.provider_key, channelId: row.channel_id, channelConnectionId: row.channel_connection_id,
      dropshipStoreConnectionId: row.dropship_store_connection_id, providerScopeType: row.provider_scope_type,
      externalScopeId: row.external_scope_id, targetRevision: row.revision });
    return { publicationTargetId: row.id, destination: destination.success ? destination.data : null,
      destinationKind: row.destination_kind, providerKey: row.provider_key ?? "", heldAt: row.held_at };
  });
}

/** Raw feed cursor text, DateStyle-independent (the Channels source's own form, D-P6-12). */
const RECENT_CURSOR_TEXT_SQL = "to_char(recent_cursor_raw, 'YYYY-MM-DD HH24:MI:SS.US')";
/**
 * A timestamptz as UTC text with all six fraction digits: node-postgres turns a timestamptz into a Date and drops its
 * microseconds, so a cursor read that way would sort before the row it was read from and find that row again every tick.
 */
const utcTimeText = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const OUTBOX_TIME_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A destination row as the tick reads it after its heartbeat. */
export interface StockLinkDestinationState {
  readonly autoLinkEnabled: boolean;
  readonly pausedUntil: Date | null;
  readonly pausedCode: string | null;
  readonly pausedSince: Date | null;
  readonly haltedAt: Date | null;
  readonly haltedCode: string | null;
  readonly retiresReleasedAt: Date | null;
  readonly recentCursor: StockLinkRecentCursor;
  /** The sweep resumes after this variant id (0: from the start). */
  readonly sweepAfterVariantId: number;
  /** The outbox time of the last dead letter scanned, as UTC text with its microseconds (a Date would drop them). */
  readonly deadLetterCursor: string | null;
}

const destinationStateSchema = z.object({
  auto_link_enabled: z.boolean(),
  paused_until: z.date().nullable(), paused_code: z.string().nullable(), paused_since: z.date().nullable(),
  halted_at: z.date().nullable(), halted_code: z.string().nullable(),
  retires_released_at: z.date().nullable(),
  recent_cursor_raw: z.string().nullable(), recent_cursor_id: z.coerce.number().int().positive().nullable(),
  sweep_cursor_variant_id: z.coerce.number().int().nonnegative().nullable(),
  dead_letter_cursor: z.string().regex(OUTBOX_TIME_TEXT_PATTERN).nullable(),
});

/**
 * §7.2 step 1 and the heartbeat: the destination row is created switch-on (D-A) if missing, and its heartbeat is
 * written when the switch is on, also for a paused or halted destination (TST-9: STALLED means only "the runner did
 * not run"). The heartbeat moves neither `revision` (a person's control is guarded by it) nor `updated_at`.
 */
export async function beatStockLinkDestination(pool: Pick<Pool, "connect">, publicationTargetId: number, now: Date):
  Promise<StockLinkDestinationState> {
  return inShortStockLinkTransaction(pool, async client => {
    await client.query(`INSERT INTO inventory.stock_link_destinations(publication_target_id, created_at, updated_at)
      VALUES ($1, $2, $2) ON CONFLICT (publication_target_id) DO NOTHING`, [publicationTargetId, now]);
    await client.query(`UPDATE inventory.stock_link_destinations SET heartbeat_at = $2
      WHERE publication_target_id = $1 AND auto_link_enabled`, [publicationTargetId, now]);
    // Both cursors as text (D-P1-4): a Date would lose their microseconds (and take the process zone for the raw one).
    const row = destinationStateSchema.parse((await client.query(`SELECT auto_link_enabled, paused_until, paused_code, paused_since,
        halted_at, halted_code, retires_released_at, ${RECENT_CURSOR_TEXT_SQL} AS recent_cursor_raw, recent_cursor_id,
        sweep_cursor_variant_id, ${utcTimeText("dead_letter_cursor_at")} AS dead_letter_cursor
      FROM inventory.stock_link_destinations WHERE publication_target_id = $1`, [publicationTargetId])).rows[0]);
    return { autoLinkEnabled: row.auto_link_enabled, pausedUntil: row.paused_until, pausedCode: row.paused_code,
      pausedSince: row.paused_since, haltedAt: row.halted_at, haltedCode: row.halted_code,
      retiresReleasedAt: row.retires_released_at,
      recentCursor: row.recent_cursor_raw === null || row.recent_cursor_id === null ? { raw: null, id: null }
        : { raw: row.recent_cursor_raw, id: row.recent_cursor_id },
      sweepAfterVariantId: row.sweep_cursor_variant_id ?? 0, deadLetterCursor: row.dead_letter_cursor };
  });
}

/** The cursors the tick moves (none of them moves `revision`: they are the engine's own bookkeeping). */
export interface StockLinkCursorUpdate {
  readonly recent?: { readonly raw: string; readonly id: number };
  /** null: the sweep reached the end and starts again from the first size. */
  readonly sweepAfterVariantId?: number | null;
  /** The last scanned dead letter's outbox time, as listStockLinkDeadLetterWakes returned it. */
  readonly deadLetterAt?: string;
}

export async function saveStockLinkCursors(pool: Pick<Pool, "connect">, publicationTargetId: number,
  update: StockLinkCursorUpdate): Promise<void> {
  if (update.recent === undefined && update.sweepAfterVariantId === undefined && update.deadLetterAt === undefined) return;
  await inShortStockLinkTransaction(pool, client => client.query(`UPDATE inventory.stock_link_destinations SET
      recent_cursor_raw = CASE WHEN $2 THEN $3::timestamp ELSE recent_cursor_raw END,
      recent_cursor_id = CASE WHEN $2 THEN $4::bigint ELSE recent_cursor_id END,
      sweep_cursor_variant_id = CASE WHEN $5 THEN $6::integer ELSE sweep_cursor_variant_id END,
      dead_letter_cursor_at = CASE WHEN $7 THEN $8::timestamptz ELSE dead_letter_cursor_at END
    WHERE publication_target_id = $1`,
  [publicationTargetId, update.recent !== undefined, update.recent?.raw ?? null, update.recent?.id ?? null,
    update.sweepAfterVariantId !== undefined, update.sweepAfterVariantId ?? null,
    update.deadLetterAt !== undefined, update.deadLetterAt ?? null]));
}

/**
 * §7.2 step 2: a check row for each size that has none: `linked` (its first verify at `firstVerifyAt`, spread by the
 * caller) when its head already has an active link, else `waiting` and due now. The sizes' catalog rows are taken
 * FOR KEY SHARE first, so a size deleted meanwhile is skipped instead of failing the row's key. Returns the sizes added.
 */
export async function insertMissingStockLinkChecks(pool: Pick<Pool, "connect">, publicationTargetId: number,
  rows: readonly { productVariantId: number; firstVerifyAt: Date }[], now: Date): Promise<number[]> {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.productVariantId - b.productVariantId);
  return inShortStockLinkTransaction(pool, async client => (await client.query<{ product_variant_id: number }>(`
    WITH sizes AS (
      SELECT v.id FROM catalog.product_variants v WHERE v.id = ANY($2::integer[]) ORDER BY v.id FOR KEY SHARE
    ), wanted AS (
      SELECT w.variant_id, w.first_verify_at FROM unnest($2::integer[], $3::timestamptz[]) AS w(variant_id, first_verify_at)
    )
    INSERT INTO inventory.stock_link_checks(publication_target_id, product_variant_id, status, next_check_at, created_at, updated_at)
    SELECT $1, w.variant_id, CASE WHEN h.active_mapping_id IS NULL THEN 'waiting' ELSE 'linked' END,
      CASE WHEN h.active_mapping_id IS NULL THEN $4::timestamptz ELSE w.first_verify_at END, $4, $4
    FROM wanted w JOIN sizes s ON s.id = w.variant_id
    LEFT JOIN inventory.publication_variant_mapping_heads h
      ON h.publication_target_id = $1 AND h.product_variant_id = w.variant_id
    ORDER BY w.variant_id
    ON CONFLICT (publication_target_id, product_variant_id) DO NOTHING
    RETURNING product_variant_id`,
  [publicationTargetId, sorted.map(row => row.productVariantId), sorted.map(row => row.firstVerifyAt), now])).rows
    .map(row => Number(row.product_variant_id)).sort((a, b) => a - b));
}

/**
 * SAF-6 / dead letters / SAF-5 holders: these sizes' rows are due now (any status but `error`). A row another claim
 * holds is left to it; a row already due is unchanged. An early wake restarts a wait's backoff (updated_at = now).
 */
export async function wakeStockLinkChecks(pool: Pick<Pool, "connect">, publicationTargetId: number,
  productVariantIds: readonly number[], now: Date): Promise<number[]> {
  if (productVariantIds.length === 0) return [];
  return inShortStockLinkTransaction(pool, async client => (await client.query<{ product_variant_id: number }>(`
    UPDATE inventory.stock_link_checks SET next_check_at = $3, updated_at = $3, revision = revision + 1
    WHERE publication_target_id = $1 AND product_variant_id = ANY($2::integer[]) AND status <> 'error'
      AND (lease_token IS NULL OR lease_expires_at <= $3) AND next_check_at > $3
    RETURNING product_variant_id`, [publicationTargetId, [...new Set(productVariantIds)].sort((a, b) => a - b), now])).rows
    .map(row => Number(row.product_variant_id)).sort((a, b) => a - b));
}

/**
 * §7.2 step 2: rows of sizes in a swept range (after `afterVariantId`, through `throughVariantId` or to the end) that
 * are no longer carried and not linked (no active link on their head) are deleted; a row a claim holds is left.
 */
export async function deleteUncarriedStockLinkChecks(pool: Pick<Pool, "connect">, publicationTargetId: number,
  range: { afterVariantId: number; throughVariantId: number | null }, carriedVariantIds: readonly number[], now: Date):
  Promise<number[]> {
  return inShortStockLinkTransaction(pool, async client => (await client.query<{ product_variant_id: number }>(`
    DELETE FROM inventory.stock_link_checks c
    WHERE c.publication_target_id = $1 AND c.product_variant_id > $2 AND ($3::integer IS NULL OR c.product_variant_id <= $3)
      AND NOT (c.product_variant_id = ANY($4::integer[]))
      AND (c.lease_token IS NULL OR c.lease_expires_at <= $5)
      AND NOT EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_heads h
        WHERE h.publication_target_id = c.publication_target_id AND h.product_variant_id = c.product_variant_id
          AND h.active_mapping_id IS NOT NULL)
    RETURNING c.product_variant_id`,
  [publicationTargetId, range.afterVariantId, range.throughVariantId, [...carriedVariantIds], now])).rows
    .map(row => Number(row.product_variant_id)).sort((a, b) => a - b));
}

/** The outbox's refusals of a store item that mean "this item may be gone" (CH/adapters/shopify-inventory-write.error.ts). */
export const STOCK_LINK_DEAD_LETTER_WAKE_CODES = Object.freeze(["SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "SHOPIFY_INVENTORY_REJECTED"]);

/**
 * §7.2 step 3: the destination's dead letters with those codes written after the cursor (the outbox's own trigger
 * time, compared only with itself), oldest first, up to `limit` and then every other one written at the last time read:
 * the cursor moves strictly past that time, so a page never ends inside a group of equal times. Their sizes are verified
 * now. The time comes back as UTC text with its microseconds (see utcTimeText).
 */
export async function listStockLinkDeadLetterWakes(pool: Pick<Pool, "query">, publicationTargetId: number, after: string | null,
  limit: number): Promise<{ productVariantIds: number[]; lastAt: string | null }> {
  const rows = (await pool.query<{ product_variant_id: number; at: string }>(`WITH due AS (
      SELECT o.id, o.product_variant_id, o.updated_at FROM inventory.inventory_publication_outbox o
      WHERE o.publication_target_id = $1 AND o.state = 'dead_letter' AND o.last_error_class = ANY($2::text[])
        AND ($3::timestamptz IS NULL OR o.updated_at > $3::timestamptz)
    ), page AS (SELECT max(updated_at) AS last FROM (SELECT updated_at FROM due ORDER BY updated_at, id LIMIT $4) first_rows)
    SELECT due.product_variant_id, ${utcTimeText("due.updated_at")} AS at
    FROM due, page WHERE due.updated_at <= page.last
    ORDER BY due.updated_at, due.id`, [publicationTargetId, [...STOCK_LINK_DEAD_LETTER_WAKE_CODES], after, limit])).rows;
  const lastAt = rows.length === 0 ? null : z.string().regex(OUTBOX_TIME_TEXT_PATTERN).parse(rows[rows.length - 1]!.at);
  return { productVariantIds: [...new Set(rows.map(row => Number(row.product_variant_id)))].sort((a, b) => a - b), lastAt };
}

/** One row as the tick's claim took it. */
export interface StockLinkClaimedCheck extends StockLinkCheckClaim {
  readonly status: StockLinkCheckFacts["status"];
  readonly observedSku: string | null;
  readonly nextCheckAt: Date;
}

const claimedRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  product_variant_id: z.coerce.number().int().positive(),
  revision: z.string().regex(/^[1-9]\d*$/),
  status: stockLinkCheckStatusSchema,
  observed_sku: z.string().nullable(),
  next_check_at: z.date(),
});

/**
 * §7.2 step 4: up to `limit` due rows (oldest next check first) FOR UPDATE SKIP LOCKED: a fresh lease and revision + 1.
 * `updated_at` and `next_check_at` are left as they were (a wait's backoff is next_check_at − updated_at, D-P4-8).
 * A row stopped on an error is never due; an expired lease is claimable.
 */
export async function claimDueStockLinkChecks(pool: Pick<Pool, "connect">, publicationTargetId: number, input: {
  now: Date; leaseToken: string; leaseMs: number; limit: number }): Promise<StockLinkClaimedCheck[]> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  return inShortStockLinkTransaction(pool, async client => (await client.query(`
    WITH due AS (
      SELECT id FROM inventory.stock_link_checks
      WHERE publication_target_id = $1 AND status <> 'error' AND next_check_at <= $2
        AND (lease_token IS NULL OR lease_expires_at <= $2)
      ORDER BY next_check_at, id LIMIT $5
      FOR UPDATE SKIP LOCKED
    )
    UPDATE inventory.stock_link_checks c SET lease_token = $3, lease_expires_at = $4, revision = c.revision + 1
    FROM due WHERE c.id = due.id
    RETURNING c.id, c.product_variant_id, c.revision::text AS revision, c.status, c.observed_sku, c.next_check_at`,
  [publicationTargetId, input.now, input.leaseToken, leaseExpiresAt, input.limit])).rows
    .map(raw => claimedRowSchema.parse(raw))
    .sort((a, b) => a.next_check_at.getTime() - b.next_check_at.getTime() || a.id - b.id)
    .map(row => ({ productVariantId: row.product_variant_id, leaseToken: input.leaseToken, revision: row.revision,
      status: row.status, observedSku: row.observed_sku, nextCheckAt: row.next_check_at })));
}

/** Every mapping head of the destination with its active and draft versions (the decision's head and holder facts). */
export interface StockLinkHeadRead {
  readonly productVariantId: number;
  readonly revision: string;
  readonly active: { readonly mappingId: number; readonly itemId: string; readonly externalSku: string | null } | null;
  readonly draft: { readonly mappingId: number; readonly itemId: string; readonly externalSku: string | null;
    readonly definitionHash: string } | null;
}

const headRowSchema = z.object({
  product_variant_id: z.coerce.number().int().positive(),
  revision: z.string().regex(/^\d+$/),
  active_mapping_id: z.coerce.number().int().positive().nullable(),
  active_item: z.string().nullable(), active_sku: z.string().nullable(),
  draft_mapping_id: z.coerce.number().int().positive().nullable(),
  draft_item: z.string().nullable(), draft_sku: z.string().nullable(), draft_hash: z.string().nullable(),
});

export async function readStockLinkDestinationHeads(pool: Pick<Pool, "query">, publicationTargetId: number): Promise<StockLinkHeadRead[]> {
  const rows = (await pool.query(`SELECT h.product_variant_id, h.revision::text AS revision,
      h.active_mapping_id, a.external_inventory_item_id AS active_item, a.external_sku AS active_sku,
      h.draft_mapping_id, d.external_inventory_item_id AS draft_item, d.external_sku AS draft_sku, d.definition_hash AS draft_hash
    FROM inventory.publication_variant_mapping_heads h
    LEFT JOIN inventory.publication_variant_mapping_versions a ON a.id = h.active_mapping_id
    LEFT JOIN inventory.publication_variant_mapping_versions d ON d.id = h.draft_mapping_id
    WHERE h.publication_target_id = $1 ORDER BY h.product_variant_id`, [publicationTargetId])).rows.map(raw => headRowSchema.parse(raw));
  return rows.map(row => {
    if ((row.active_mapping_id === null) !== (row.active_item === null)
      || (row.draft_mapping_id === null) !== (row.draft_item === null || row.draft_hash === null)) {
      // The head points at a version that is not there: impossible under the 0633 coherence trigger.
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A mapping head names a version that cannot be read.",
        { publicationTargetId, productVariantId: row.product_variant_id });
    }
    return { productVariantId: row.product_variant_id, revision: row.revision,
      active: row.active_mapping_id === null ? null
        : { mappingId: row.active_mapping_id, itemId: row.active_item!, externalSku: row.active_sku },
      draft: row.draft_mapping_id === null ? null
        : { mappingId: row.draft_mapping_id, itemId: row.draft_item!, externalSku: row.draft_sku, definitionHash: row.draft_hash! } };
  });
}

/**
 * Retires without replacement in the hold window (§4.2 RETIRES_HELD, TST-8): versions the engine retired whose head
 * has no active version again, retired after `windowStart` (stockLinkRetireWindowStart with the injected clock, a
 * parameter, never the database clock). Ops Health counts the same rows with the same predicate (stock-link-health.sql.ts).
 */
export const STOCK_LINK_RETIRES_WITHOUT_REPLACEMENT_SQL = stockLinkRetiresWithoutReplacementCountText({
  publicationTargetId: "$1", actor: "$2", windowStart: "$3" });

export async function countStockLinkRetiresWithoutReplacement(pool: Pick<Pool, "query">, publicationTargetId: number,
  actor: string, windowStart: Date): Promise<number> {
  const row = (await pool.query<{ count: number }>(STOCK_LINK_RETIRES_WITHOUT_REPLACEMENT_SQL,
    [publicationTargetId, actor, windowStart])).rows[0];
  return z.coerce.number().int().nonnegative().parse(row?.count ?? 0);
}

/** Claimed rows of sizes no longer carried and not linked (BUILD-NOTES D-P6-10): deleted under their claim's guard. */
export async function deleteClaimedStockLinkChecks(pool: Pick<Pool, "connect">, publicationTargetId: number,
  guards: readonly StockLinkCheckGuard[]): Promise<number[]> {
  if (guards.length === 0) return [];
  return inShortStockLinkTransaction(pool, async client => {
    const deleted: number[] = [];
    for (const guard of [...guards].sort((a, b) => a.productVariantId - b.productVariantId)) {
      const result = await client.query(`DELETE FROM inventory.stock_link_checks
        WHERE publication_target_id = $1 AND product_variant_id = $2 AND revision = $3::bigint
          AND lease_token IS NOT DISTINCT FROM $4::uuid`, [publicationTargetId, guard.productVariantId, guard.revision, guard.leaseToken]);
      if (result.rowCount === 1) deleted.push(guard.productVariantId);
    }
    return deleted;
  });
}

/**
 * A destination pause (§4.6): `paused_until` as the caller computed it (stockLinkPauseDelayMs), the code, and the
 * pause's start kept from an earlier pause. Returns whether the pause started now (it was not paused).
 */
export async function pauseStockLinkDestination(pool: Pick<Pool, "connect">, publicationTargetId: number,
  input: { code: string; now: Date; until: Date }): Promise<boolean> {
  return inShortStockLinkTransaction(pool, async client => {
    const before = (await client.query<{ paused_since: Date | null }>(`SELECT paused_since FROM inventory.stock_link_destinations
      WHERE publication_target_id = $1 FOR UPDATE`, [publicationTargetId])).rows[0];
    if (!before) throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A stock-link destination row is missing.", { publicationTargetId });
    await client.query(`UPDATE inventory.stock_link_destinations SET paused_until = $2, paused_code = $3,
        paused_since = COALESCE(paused_since, $4), revision = revision + 1, updated_at = $4
      WHERE publication_target_id = $1`, [publicationTargetId, input.until, input.code, input.now]);
    return before.paused_since === null;
  });
}

/** Lifts a pause with one of `codes` (a control answered, or the store's login works again). Returns the code lifted. */
export async function clearStockLinkDestinationPause(pool: Pick<Pool, "connect">, publicationTargetId: number,
  codes: readonly string[], now: Date): Promise<string | null> {
  return inShortStockLinkTransaction(pool, async client => {
    const before = (await client.query<{ paused_code: string | null }>(`SELECT paused_code FROM inventory.stock_link_destinations
      WHERE publication_target_id = $1 FOR UPDATE`, [publicationTargetId])).rows[0];
    if (!before?.paused_code || !codes.includes(before.paused_code)) return null;
    await client.query(`UPDATE inventory.stock_link_destinations SET paused_until = NULL, paused_code = NULL, paused_since = NULL,
        revision = revision + 1, updated_at = $2 WHERE publication_target_id = $1`, [publicationTargetId, now]);
    return before.paused_code;
  });
}

/** A destination halt on a fatal failure (DV4-13), until Check again. Returns whether it halted now (once: one ERROR). */
export async function haltStockLinkDestination(pool: Pick<Pool, "connect">, publicationTargetId: number,
  input: { code: string; now: Date }): Promise<boolean> {
  return inShortStockLinkTransaction(pool, async client => (await client.query(`UPDATE inventory.stock_link_destinations
    SET halted_at = $2, halted_code = $3, revision = revision + 1, updated_at = $2
    WHERE publication_target_id = $1 AND halted_at IS NULL`, [publicationTargetId, input.now, input.code])).rowCount === 1);
}
