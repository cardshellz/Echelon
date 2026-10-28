import type { Pool } from "pg";
import { z } from "zod";
import type { StockLinkSupportedStatus } from "@shared/types/stock-link";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { STOCK_LINK_DECISION_CODES, STOCK_LINK_RETIRE_HOLD } from "../domain/stock-link";
import {
  STOCK_LINK_CHECK_AGAIN_STATUSES, STOCK_LINK_CONTROL_AUDIT_ACTIONS, planStockLinkControl,
  type StockLinkControlPlan,
} from "../domain/stock-link-controls";
import type {
  StockLinkControlCommand, StockLinkControlOutcome, StockLinkControlSnapshot, StockLinkControlsStore, StockLinkUnsupportedStatus,
} from "../application/stock-link-controls.service";
import { stockLinkRetiresHeldCountText } from "./stock-link-health.sql";

/**
 * The Channel Inventory stock-link controls over PostgreSQL (channels PR2, PLAN-CH2 v4.1 §7.3): the status read and
 * the three audited writes (switch, Continue, Check again) on inventory.stock_link_destinations / stock_link_checks.
 * Each write is one READ COMMITTED transaction: the destination row FOR UPDATE (a running command holds it FOR SHARE,
 * so a switch-off waits for it and the next command sees it), the revision guard, the change (domain/
 * stock-link-controls.ts decides what), the destination revision + 1 and one public.audit_events row; the answer is
 * the status as that transaction leaves it.
 *
 * Locks: at most 5 s for any lock (a command or a tick write holds the row briefly), then 409 busy. Check again never
 * waits on a check row: rows a command holds (locked) or a live claim leases are left to that claim, which records
 * its own outcome a moment later. Nothing here calls a provider.
 */

type Queryable = Pick<Pool, "query">;

/** The engine runs for these destinations (today: Card Shellz's own Shopify stores; the registry's only binding,
 * server/services/index.ts). A unit test pins it to the Shopify adapter's own kind and provider. */
export const STOCK_LINK_CONTROLLED_DESTINATIONS = Object.freeze([
  Object.freeze({ destinationKind: "channel_connection", providerKey: "shopify" }),
]);

const CONTROL_LOCK_TIMEOUT = "5s";

const notFound = (publicationTargetId: number) => new InventoryAvailabilityMasterDataError(404,
  "STOCK_LINK_DESTINATION_NOT_FOUND", "The publication target does not exist.", [`publicationTargetId: ${publicationTargetId}`]);
// The 409 messages reach staff when a client has no words of its own for the code (Channel Inventory has, review TST-2).
const unsupported = () => new InventoryAvailabilityMasterDataError(409, "STOCK_LINK_DESTINATION_UNSUPPORTED",
  /* PROPOSED: owner wording */ "Automatic linking is not available for this store.");
const stale = () => new InventoryAvailabilityMasterDataError(409, "STOCK_LINK_DESTINATION_STALE",
  /* PROPOSED: owner wording */ "Linking for this store changed on another screen. Reload, check it, then try again.");
const busy = () => new InventoryAvailabilityMasterDataError(409, "STOCK_LINK_DESTINATION_BUSY",
  /* PROPOSED: owner wording */ "Echelon is checking this store right now. Try again in a moment.");

const targetRowSchema = z.object({ destination_kind: z.string(), provider_key: z.string().nullable() });
const destinationRowSchema = z.object({
  auto_link_enabled: z.boolean(),
  paused_until: z.date().nullable(), paused_code: z.string().nullable(), paused_since: z.date().nullable(),
  halted_at: z.date().nullable(), halted_code: z.string().nullable(),
  retires_released_at: z.date().nullable(), retires_released_by: z.string().nullable(),
  revision: z.string().regex(/^[1-9]\d*$/),
});
type DestinationRow = z.infer<typeof destinationRowSchema>;
const DESTINATION_COLUMNS = `auto_link_enabled, paused_until, paused_code, paused_since, halted_at, halted_code,
  retires_released_at, retires_released_by, revision::text AS revision`;

/** The row a destination has before the tick or a control ever created it: switch on (D-A), nothing else. */
const NO_ROW: DestinationRow = { auto_link_enabled: true, paused_until: null, paused_code: null, paused_since: null,
  halted_at: null, halted_code: null, retires_released_at: null, retires_released_by: null, revision: "0" };

/** Whether the engine runs for the target, or null when the target does not exist. */
async function readTargetSupport(client: Queryable, publicationTargetId: number): Promise<boolean | null> {
  const raw = (await client.query(`SELECT t.destination_kind,
      CASE t.destination_kind WHEN 'channel_connection' THEN lower(c.provider) ELSE lower(d.platform) END AS provider_key
    FROM inventory.inventory_publication_targets t
    JOIN channels.channels c ON c.id = t.channel_id
    LEFT JOIN dropship.dropship_store_connections d ON d.id = t.dropship_store_connection_id
    WHERE t.id = $1`, [publicationTargetId])).rows[0];
  if (!raw) return null;
  const row = targetRowSchema.parse(raw);
  return STOCK_LINK_CONTROLLED_DESTINATIONS.some(entry => entry.destinationKind === row.destination_kind
    && entry.providerKey === row.provider_key);
}

async function readDestination(client: Queryable, publicationTargetId: number, lock: "" | "FOR UPDATE"):
  Promise<DestinationRow | null> {
  const raw = (await client.query(`SELECT ${DESTINATION_COLUMNS} FROM inventory.stock_link_destinations
    WHERE publication_target_id = $1 ${lock}`, [publicationTargetId])).rows[0];
  return raw ? destinationRowSchema.parse(raw) : null;
}

/** The sizes whose retire the hold keeps right now: the same predicate as Ops Health's RETIRES_HELD (review LNK-3). */
const RETIRES_HELD_COUNT_SQL = stockLinkRetiresHeldCountText({ publicationTargetId: "$1", now: "$2::timestamptz" });

async function countHeldRetires(client: Queryable, publicationTargetId: number, now: Date): Promise<number> {
  const result = (await client.query<{ count: unknown }>(RETIRES_HELD_COUNT_SQL, [publicationTargetId, now])).rows[0];
  return z.coerce.number().int().nonnegative().parse(result?.count ?? 0);
}

function snapshot(row: DestinationRow): StockLinkControlSnapshot {
  return {
    autoLinkEnabled: row.auto_link_enabled,
    revision: row.revision,
    paused: row.paused_code !== null && row.paused_since !== null && row.paused_until !== null
      ? { code: row.paused_code, since: row.paused_since.toISOString(), until: row.paused_until.toISOString() } : null,
    halted: row.halted_code !== null && row.halted_at !== null ? { code: row.halted_code, at: row.halted_at.toISOString() } : null,
    retiresReleased: row.retires_released_at !== null && row.retires_released_by !== null
      ? { at: row.retires_released_at.toISOString(), by: row.retires_released_by } : null,
  };
}

async function readSupportedStatus(client: Queryable, publicationTargetId: number, row: DestinationRow, now: Date):
  Promise<StockLinkSupportedStatus> {
  const counts = { linked: 0, waiting: 0, flagged: 0, error: 0 };
  const grouped = (await client.query<{ status: string; count: unknown }>(`SELECT status, count(*)::int AS count
    FROM inventory.stock_link_checks WHERE publication_target_id = $1 GROUP BY status`, [publicationTargetId])).rows;
  for (const entry of grouped) {
    const status = z.enum(["linked", "waiting", "flagged", "error"]).parse(entry.status);
    counts[status] = z.coerce.number().int().nonnegative().parse(entry.count);
  }
  const held = row.revision === "0" ? 0 : await countHeldRetires(client, publicationTargetId, now);
  const view = snapshot(row);
  return {
    supported: true,
    publicationTargetId,
    autoLinkEnabled: row.auto_link_enabled,
    revision: row.revision,
    counts,
    paused: view.paused,
    halted: view.halted,
    // `count` = the sizes whose link the hold kept (the held callout's number), not the window's retires (review LNK-3).
    retiresHeld: held > 0
      ? { count: held, limit: STOCK_LINK_RETIRE_HOLD.limit, windowHours: STOCK_LINK_RETIRE_HOLD.windowHours } : null,
  };
}

function isLockTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "55P03");
}

export class PostgresStockLinkControlsStore implements StockLinkControlsStore {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  /** The status route (§7.3): read-only, no lock; a destination the tick never set up reads as "switch on, revision 0". */
  async readStatus(publicationTargetId: number, now: Date): Promise<StockLinkSupportedStatus | StockLinkUnsupportedStatus> {
    const supported = await readTargetSupport(this.pool, publicationTargetId);
    if (supported === null) throw notFound(publicationTargetId);
    if (!supported) return { supported: false, publicationTargetId };
    const row = await readDestination(this.pool, publicationTargetId, "") ?? NO_ROW;
    return readSupportedStatus(this.pool, publicationTargetId, row, now);
  }

  async apply(command: StockLinkControlCommand): Promise<StockLinkControlOutcome> {
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SET LOCAL lock_timeout = '${CONTROL_LOCK_TIMEOUT}'`);
      const outcome = await this.applyInside(client, command);
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection's state is unknown: never return it to the pool.
        discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        throw new AggregateError([error, rollbackError], "A stock-link control and its rollback failed.");
      }
      throw isLockTimeout(error) ? busy() : error;
    } finally {
      client.release(discard);
    }
  }

  private async applyInside(client: Queryable, command: StockLinkControlCommand): Promise<StockLinkControlOutcome> {
    const { publicationTargetId, occurredAt: now } = command;
    const supported = await readTargetSupport(client, publicationTargetId);
    if (supported === null) throw notFound(publicationTargetId);
    if (!supported) throw unsupported();

    let before = await readDestination(client, publicationTargetId, "FOR UPDATE");
    if (before === null) {
      // No row yet: the client read revision "0" (switch on). The row is created here with its defaults; a tick that
      // created it first makes the read stale, exactly as a changed revision does.
      if (command.expectedRevision !== "0") throw stale();
      const inserted = await client.query(`INSERT INTO inventory.stock_link_destinations(publication_target_id, created_at, updated_at)
        VALUES ($1, $2, $2) ON CONFLICT (publication_target_id) DO NOTHING RETURNING publication_target_id`, [publicationTargetId, now]);
      if (inserted.rowCount !== 1) throw stale();
      before = (await readDestination(client, publicationTargetId, "FOR UPDATE"))!;
    } else if (before.revision !== command.expectedRevision) {
      throw stale();
    }

    const retiresHeld = (await countHeldRetires(client, publicationTargetId, now)) > 0;
    const plan = planStockLinkControl(command.request, { autoLinkEnabled: before.auto_link_enabled,
      pausedUntil: before.paused_until, haltedAt: before.halted_at, retiresHeld }, now);
    if (!plan.changed) {
      return { kind: command.request.kind, changed: false, before: snapshot(before), after: snapshot(before),
        productVariantIdsMadeDue: [], status: await readSupportedStatus(client, publicationTargetId, before, now) };
    }

    await this.writeDestination(client, publicationTargetId, plan, command);
    const madeDue = plan.makeRowsDue ? await makeChecksDue(client, publicationTargetId, now)
      : plan.releaseRetires ? await makeHeldRetiresDue(client, publicationTargetId, now) : [];
    const after = (await readDestination(client, publicationTargetId, ""))!;
    const beforeView = snapshot(before);
    const afterView = snapshot(after);
    await client.query(`INSERT INTO public.audit_events(timestamp, level, actor, action, target, changes, context)
      VALUES ($1, 'AUDIT', $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [now, command.actorId, STOCK_LINK_CONTROL_AUDIT_ACTIONS[command.request.kind], `inventory.inventory_publication_target:${publicationTargetId}`,
      JSON.stringify({ before: beforeView, after: afterView }),
      JSON.stringify({ reason: command.reason, expectedRevision: command.expectedRevision, retiresHeld,
        releasedRetires: plan.releaseRetires, resumedPause: plan.resumePause, clearedHalt: plan.clearHalt,
        rowsMadeDue: madeDue.length, productVariantIds: madeDue })]);
    return { kind: command.request.kind, changed: true, before: beforeView, after: afterView, productVariantIdsMadeDue: madeDue,
      status: await readSupportedStatus(client, publicationTargetId, after, now) };
  }

  private async writeDestination(client: Queryable, publicationTargetId: number, plan: StockLinkControlPlan,
    command: StockLinkControlCommand): Promise<void> {
    await client.query(`UPDATE inventory.stock_link_destinations SET
        auto_link_enabled = $2,
        retires_released_at = CASE WHEN $3 THEN $6::timestamptz ELSE retires_released_at END,
        retires_released_by = CASE WHEN $3 THEN $7 ELSE retires_released_by END,
        paused_until = CASE WHEN $4 AND paused_until IS NOT NULL THEN $6::timestamptz ELSE paused_until END,
        halted_at = CASE WHEN $5 THEN NULL ELSE halted_at END,
        halted_code = CASE WHEN $5 THEN NULL ELSE halted_code END,
        revision = revision + 1, updated_at = $6
      WHERE publication_target_id = $1`,
    [publicationTargetId, plan.autoLinkEnabled, plan.releaseRetires, plan.resumePause, plan.clearHalt, command.occurredAt, command.actorId]);
  }
}

/**
 * Check again (§7.3): every error, flagged and linked row of the destination is due now with its attempts and streaks
 * reset. A row stopped on an error comes back as `linked` when its size still has an active link, else `waiting`
 * (the next check decides again; nothing about the error is kept but the audit row). Rows another transaction holds
 * (SKIP LOCKED) or a live claim leases are left to that claim. Returns the sizes made due.
 */
async function makeChecksDue(client: Queryable, publicationTargetId: number, now: Date): Promise<number[]> {
  const rows = (await client.query<{ product_variant_id: number }>(`WITH due AS (
      SELECT c.id FROM inventory.stock_link_checks c
      WHERE c.publication_target_id = $1 AND c.status = ANY($3::text[])
        AND (c.lease_token IS NULL OR c.lease_expires_at <= $2)
      ORDER BY c.id FOR UPDATE SKIP LOCKED
    )
    UPDATE inventory.stock_link_checks c SET
      status = CASE WHEN c.status <> 'error' THEN c.status
        WHEN EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_heads h
          WHERE h.publication_target_id = c.publication_target_id AND h.product_variant_id = c.product_variant_id
            AND h.active_mapping_id IS NOT NULL) THEN 'linked' ELSE 'waiting' END,
      reason_code = CASE WHEN c.status = 'error' THEN NULL ELSE c.reason_code END,
      error_class = CASE WHEN c.status = 'error' THEN NULL ELSE c.error_class END,
      message = CASE WHEN c.status = 'error' THEN NULL ELSE c.message END,
      attempt_count = 0, first_failure_at = NULL, busy_since = NULL,
      next_check_at = $2, updated_at = $2, revision = c.revision + 1
    FROM due WHERE c.id = due.id
    RETURNING c.product_variant_id`, [publicationTargetId, now, [...STOCK_LINK_CHECK_AGAIN_STATUSES]])).rows;
  return rows.map(row => Number(row.product_variant_id)).sort((a, b) => a - b);
}

/**
 * Continue (review LNK-1): the sizes whose retire the hold kept are due now, so the next tick decides them with the
 * released window instead of in 24 h. Attempts and reason stay (the next decision rewrites them). Rows another
 * transaction holds (SKIP LOCKED) or a live claim leases are left to that claim, as Check again does. Returns the
 * sizes made due.
 */
async function makeHeldRetiresDue(client: Queryable, publicationTargetId: number, now: Date): Promise<number[]> {
  const rows = (await client.query<{ product_variant_id: number }>(`WITH due AS (
      SELECT c.id FROM inventory.stock_link_checks c
      WHERE c.publication_target_id = $1 AND c.reason_code = $3 AND c.next_check_at > $2
        AND (c.lease_token IS NULL OR c.lease_expires_at <= $2)
      ORDER BY c.id FOR UPDATE SKIP LOCKED
    )
    UPDATE inventory.stock_link_checks c SET next_check_at = $2, updated_at = $2, revision = c.revision + 1
    FROM due WHERE c.id = due.id
    RETURNING c.product_variant_id`, [publicationTargetId, now, STOCK_LINK_DECISION_CODES.retiresHeld])).rows;
  return rows.map(row => Number(row.product_variant_id)).sort((a, b) => a - b);
}
