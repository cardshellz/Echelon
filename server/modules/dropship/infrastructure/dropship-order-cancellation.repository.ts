import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipOrderCancellationCandidate,
  DropshipOrderCancellationRepository,
} from "../application/dropship-order-cancellation-service";

const CANCELLATION_PROCESSING_STATUS = "marketplace_cancellation_processing" as const;
const CANCELLATION_RETRYING_STATUS = "marketplace_cancellation_retrying" as const;
const CANCELLATION_FAILED_STATUS = "marketplace_cancellation_failed" as const;
const CANCELLATION_SUCCEEDED_STATUS = "marketplace_cancelled" as const;
const CLAIMABLE_CANCELLATION_STATUSES = [
  "payment_hold_expired",
  CANCELLATION_RETRYING_STATUS,
] as const;
const STALE_CANCELLATION_PROCESSING_MINUTES = 15;

interface CancellationCandidateRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: "ebay" | "shopify";
  external_order_id: string;
  external_order_number: string | null;
  source_order_id: string | null;
  ordered_at: string | null;
  cancellation_status: DropshipOrderCancellationCandidate["cancellationStatus"];
}

interface CancellationActionRow extends CancellationCandidateRow {
  status: string;
  rejection_reason: string | null;
}

export class PgDropshipOrderCancellationRepository implements DropshipOrderCancellationRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async claimPendingCancellations(input: {
    now: Date;
    limit: number;
    workerId: string;
  }): Promise<DropshipOrderCancellationCandidate[]> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CancellationCandidateRow>(
        `WITH candidates AS (
           SELECT id
           FROM dropship.dropship_order_intake
           WHERE status = 'cancelled'
             AND oms_order_id IS NULL
             AND (
               cancellation_status = ANY($2::varchar[])
               OR (
                 cancellation_status = $3
                 AND updated_at <= $1 - ($4::text)::interval
               )
             )
           ORDER BY updated_at ASC, id ASC
           LIMIT $5
           FOR UPDATE SKIP LOCKED
         )
         UPDATE dropship.dropship_order_intake AS oi
         SET cancellation_status = $3,
             updated_at = $1
         FROM candidates
         WHERE oi.id = candidates.id
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
                   oi.external_order_id, oi.external_order_number, oi.source_order_id,
                   oi.normalized_payload->>'orderedAt' AS ordered_at,
                   oi.cancellation_status`,
        [
          input.now,
          CLAIMABLE_CANCELLATION_STATUSES,
          CANCELLATION_PROCESSING_STATUS,
          `${STALE_CANCELLATION_PROCESSING_MINUTES} minutes`,
          input.limit,
        ],
      );
      await client.query("COMMIT");
      return result.rows.map(mapCancellationCandidateRow);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMarketplaceCancellationSuccess(
    input: Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationSuccess"]>[0],
  ): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const row = await updateCancellationOutcome(client, {
        intakeId: input.candidate.intakeId,
        cancellationStatus: CANCELLATION_SUCCEEDED_STATUS,
        status: "cancelled",
        rejectionReason: null,
        now: input.now,
      });
      await recordCancellationAuditEvent(client, {
        row,
        workerId: input.workerId,
        eventType: "order_marketplace_cancellation_succeeded",
        severity: "info",
        payload: {
          previousCancellationStatus: input.candidate.cancellationStatus,
          cancellationStatus: CANCELLATION_SUCCEEDED_STATUS,
          marketplaceStatus: input.result.status,
          externalCancellationId: input.result.externalCancellationId,
          rawResult: input.result.rawResult,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMarketplaceCancellationFailure(
    input: Parameters<DropshipOrderCancellationRepository["recordMarketplaceCancellationFailure"]>[0],
  ): Promise<void> {
    const client = await this.dbPool.connect();
    const cancellationStatus = input.retryable ? CANCELLATION_RETRYING_STATUS : CANCELLATION_FAILED_STATUS;
    const status = input.retryable ? "cancelled" : "exception";
    const rejectionReason = buildCancellationFailureReason(input.errorCode, input.errorMessage);
    try {
      await client.query("BEGIN");
      const row = await updateCancellationOutcome(client, {
        intakeId: input.candidate.intakeId,
        cancellationStatus,
        status,
        rejectionReason,
        now: input.now,
      });
      await recordCancellationAuditEvent(client, {
        row,
        workerId: input.workerId,
        eventType: input.retryable
          ? "order_marketplace_cancellation_retry_scheduled"
          : "order_marketplace_cancellation_failed",
        severity: input.retryable ? "warning" : "error",
        payload: {
          previousCancellationStatus: input.candidate.cancellationStatus,
          cancellationStatus,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          retryable: input.retryable,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function updateCancellationOutcome(
  client: PoolClient,
  input: {
    intakeId: number;
    status: "cancelled" | "exception";
    cancellationStatus: string;
    rejectionReason: string | null;
    now: Date;
  },
): Promise<CancellationActionRow> {
  const result = await client.query<CancellationActionRow>(
    `UPDATE dropship.dropship_order_intake AS oi
     SET status = $2,
         cancellation_status = $3,
        rejection_reason = $4,
         updated_at = $5
     WHERE oi.id = $1
       AND oi.cancellation_status = $6
     RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.platform,
               oi.external_order_id, oi.external_order_number, oi.source_order_id,
               oi.normalized_payload->>'orderedAt' AS ordered_at,
               oi.status, oi.rejection_reason, oi.cancellation_status`,
    [
      input.intakeId,
      input.status,
      input.cancellationStatus,
      input.rejectionReason,
      input.now,
      CANCELLATION_PROCESSING_STATUS,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Dropship marketplace cancellation outcome update failed for intake ${input.intakeId}.`);
  }
  return row;
}

async function recordCancellationAuditEvent(
  client: PoolClient,
  input: {
    row: CancellationActionRow;
    workerId: string;
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
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
             'job', $5, $6, $7::jsonb, $8)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.eventType,
      input.workerId,
      input.severity,
      JSON.stringify({
        externalOrderId: input.row.external_order_id,
        externalOrderNumber: input.row.external_order_number,
        sourceOrderId: input.row.source_order_id,
        status: input.row.status,
        rejectionReason: input.row.rejection_reason,
        ...input.payload,
      }),
      input.occurredAt,
    ],
  );
}

function mapCancellationCandidateRow(row: CancellationCandidateRow): DropshipOrderCancellationCandidate {
  return {
    intakeId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    externalOrderId: row.external_order_id,
    externalOrderNumber: row.external_order_number,
    sourceOrderId: row.source_order_id,
    orderedAt: row.ordered_at,
    cancellationStatus: row.cancellation_status,
  };
}

function buildCancellationFailureReason(errorCode: string, errorMessage: string): string {
  return `Marketplace cancellation failed: ${errorCode} - ${errorMessage}`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
