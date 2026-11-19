import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipBelowCostSaleNotices } from "../application/dropship-order-acceptance-service";
import {
  MARKETPLACE_SYNC_NOTICE_KINDS,
  orderBelowCostNotices,
  type MarketplaceSyncNoticeIntent,
  type MarketplaceSyncNoticeKind,
} from "../domain/marketplace-sync-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";
import { planMarketplaceSyncNoticeBatches, type MarketplaceSyncNoticeBatchPlan } from "../domain/marketplace-sync-notice-batches";

/**
 * eBay sync-back's vendor notice outbox (plan v4 §6.6, SB24). A notice row is
 * written in the same transaction as the change it tells about, so a change
 * is never lost to a failed send and a rolled-back change never notifies.
 * Sending is three steps: claim pending rows into batches (a short
 * transaction, rows locked SKIP LOCKED so two processes never claim the
 * same row), send each batch with its key as the notification's idempotency
 * key, then mark it sent. A failed send leaves the batch unsent; the next
 * tick sends the same batch with the same key, which the notification
 * service replays instead of sending twice. A batch the notification service
 * refuses for good is dead-lettered: never claimed, listed or sent again
 * (CLAUDE.md §6, permanent), and counted by ops health for a person.
 */
type Client = Pick<PoolClient, "query">;

/** The largest payload a notice row keeps (facts only; the words are made at send time). */
export const MAX_NOTICE_PAYLOAD_JSON_LENGTH = 8_000;
/** Rows claimed per call: a tick sends a bounded amount (PROPOSED). */
export const MAX_NOTICES_CLAIMED_PER_CALL = 500;

/**
 * Writes notices for one store; a subject already written for that store and
 * kind is a no-op, so a replayed decision notifies once. Answers how many
 * rows are new.
 */
export async function enqueueMarketplaceSyncNoticesWithClient(client: Client, input: {
  vendorId: number; storeConnectionId: number; notices: readonly MarketplaceSyncNoticeIntent[]; createdAt: Date;
}): Promise<number> {
  if (input.notices.length === 0) return 0;
  for (const notice of input.notices) assertNotice(notice);
  const result = await client.query(`INSERT INTO dropship.dropship_marketplace_sync_notices
      (vendor_id, store_connection_id, kind, subject_key, critical, payload, created_at)
    SELECT $1, $2, notice.kind, notice.subject_key, notice.critical, notice.payload, $4
    FROM jsonb_to_recordset($3::jsonb) AS notice(kind text, subject_key text, critical boolean, payload jsonb)
    ON CONFLICT (store_connection_id, kind, subject_key) DO NOTHING`,
  [input.vendorId, input.storeConnectionId, JSON.stringify(input.notices.map((notice) => ({ kind: notice.kind,
    subject_key: notice.subjectKey, critical: notice.critical, payload: notice.payload }))), input.createdAt]);
  return result.rowCount ?? 0;
}

/**
 * Claims the pending rows into batches, one per store and kind
 * (planMarketplaceSyncNoticeBatches), and stamps each row with its batch key.
 * Rows another process holds are skipped, never waited for. Answers the
 * batches claimed.
 */
export async function claimMarketplaceSyncNoticeBatchesWithClient(client: Client): Promise<MarketplaceSyncNoticeBatchPlan[]> {
  const pending = await client.query<{ id: number; store_connection_id: number; kind: string }>(`
    SELECT id, store_connection_id, kind FROM dropship.dropship_marketplace_sync_notices
    WHERE sent_at IS NULL AND batch_key IS NULL AND dead_lettered_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
  [MAX_NOTICES_CLAIMED_PER_CALL]);
  const rows = pending.rows.filter((row) => isNoticeKind(row.kind))
    .map((row) => ({ id: row.id, storeConnectionId: row.store_connection_id, kind: row.kind as MarketplaceSyncNoticeKind }));
  const batches = planMarketplaceSyncNoticeBatches(rows);
  for (const batch of batches) {
    await client.query(`UPDATE dropship.dropship_marketplace_sync_notices SET batch_key = $2
      WHERE id = ANY($1::int[]) AND batch_key IS NULL AND sent_at IS NULL`, [batch.noticeIds, batch.batchKey]);
  }
  return batches;
}

export interface MarketplaceSyncNoticeBatch {
  batchKey: string;
  vendorId: number;
  storeConnectionId: number;
  kind: MarketplaceSyncNoticeKind;
  critical: boolean;
  payloads: Record<string, unknown>[];
  createdAt: Date;
}

/** Claimed batches not yet sent, oldest first: what a tick sends (again, after a failed send). */
export async function listUnsentMarketplaceSyncNoticeBatchesWithClient(client: Client, limit: number): Promise<MarketplaceSyncNoticeBatch[]> {
  const result = await client.query<{ batch_key: string; vendor_id: number; store_connection_id: number; kind: string;
    critical: boolean; payloads: Record<string, unknown>[]; created_at: Date }>(`
    SELECT batch_key, min(vendor_id) AS vendor_id, min(store_connection_id) AS store_connection_id, min(kind) AS kind,
      bool_or(critical) AS critical, jsonb_agg(payload ORDER BY id) AS payloads, min(created_at) AS created_at
    FROM dropship.dropship_marketplace_sync_notices WHERE batch_key IS NOT NULL AND sent_at IS NULL AND dead_lettered_at IS NULL
    GROUP BY batch_key ORDER BY min(id) LIMIT $1`, [limit]);
  return result.rows.filter((row) => isNoticeKind(row.kind)).map((row) => ({
    batchKey: row.batch_key, vendorId: row.vendor_id, storeConnectionId: row.store_connection_id,
    kind: row.kind as MarketplaceSyncNoticeKind, critical: row.critical, payloads: row.payloads, createdAt: row.created_at,
  }));
}

/** Marks a sent batch. A second call is a no-op. Answers how many rows it marked. */
export async function markMarketplaceSyncNoticeBatchSentWithClient(client: Client, input: { batchKey: string; sentAt: Date }): Promise<number> {
  const result = await client.query(`UPDATE dropship.dropship_marketplace_sync_notices SET sent_at = $2
    WHERE batch_key = $1 AND sent_at IS NULL AND dead_lettered_at IS NULL`, [input.batchKey, input.sentAt]);
  return result.rowCount ?? 0;
}

/** The code a dead-lettered batch keeps: the refusal's own code (the column's CHECK), else UNEXPECTED_ERROR. */
const FAILURE_CODE_PATTERN = /^[A-Z0-9_]{1,120}$/;

/**
 * Stops a batch the notification service refused for good: its rows are
 * never claimed, listed or sent again and keep the refusal's code for the
 * person who reviews them. A second call, or a call for a batch already sent,
 * is a no-op. Answers how many rows it stopped.
 */
export async function deadLetterMarketplaceSyncNoticeBatchWithClient(client: Client, input: {
  batchKey: string; failureCode: string; at: Date;
}): Promise<number> {
  const failureCode = FAILURE_CODE_PATTERN.test(input.failureCode) ? input.failureCode : "UNEXPECTED_ERROR";
  const result = await client.query(`UPDATE dropship.dropship_marketplace_sync_notices SET dead_lettered_at = $3, failure_code = $2
    WHERE batch_key = $1 AND sent_at IS NULL AND dead_lettered_at IS NULL`, [input.batchKey, failureCode, input.at]);
  return result.rowCount ?? 0;
}

function isNoticeKind(kind: string): kind is MarketplaceSyncNoticeKind {
  return Object.prototype.hasOwnProperty.call(MARKETPLACE_SYNC_NOTICE_KINDS, kind);
}

/** A notice whose kind, criticality or payload is not what the registry says is a defect in its writer. */
function assertNotice(notice: MarketplaceSyncNoticeIntent): void {
  const definition = isNoticeKind(notice.kind) ? MARKETPLACE_SYNC_NOTICE_KINDS[notice.kind] : null;
  const payloadLength = JSON.stringify(notice.payload).length;
  if (!definition || definition.critical !== notice.critical || payloadLength > MAX_NOTICE_PAYLOAD_JSON_LENGTH) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sync-back notice does not match its kind.", "fatal",
      { kind: notice.kind, critical: notice.critical, payloadLength });
  }
}

/**
 * The below-cost warning of a freshly accepted order (plan v3 §7.4, owner
 * rule 7a): written in its own transaction after the acceptance committed,
 * once per listing and UTC day (the outbox's unique subject). Answers how
 * many rows are new.
 */
export class PgDropshipBelowCostSaleNotices implements DropshipBelowCostSaleNotices {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async enqueue(input: Parameters<DropshipBelowCostSaleNotices["enqueue"]>[0]): Promise<number> {
    const notices = orderBelowCostNotices({ lines: input.lines, at: input.at });
    if (notices.length === 0) return 0;
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const written = await enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId, notices, createdAt: input.at });
      await client.query("COMMIT");
      return written;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original error is the one to report; a failed rollback ends with the connection.
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
