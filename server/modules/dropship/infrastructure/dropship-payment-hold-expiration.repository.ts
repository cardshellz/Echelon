import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipExpiringPaymentHoldRecord,
  DropshipExpiredPaymentHoldRecord,
  DropshipPaymentHoldExpirationRepository,
} from "../application/dropship-payment-hold-expiration-service";

const PAYMENT_HOLD_EXPIRED_REASON = "Payment hold expired before wallet funds were available.";
const PAYMENT_HOLD_EXPIRED_STATUS = "payment_hold_expired" as const;

interface ExpiredPaymentHoldRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  external_order_id: string;
  payment_hold_expires_at: Date;
  cancellation_status: string | null;
}

export class PgDropshipPaymentHoldExpirationRepository implements DropshipPaymentHoldExpirationRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listExpiringPaymentHolds(input: {
    now: Date;
    warningWindowMinutes: number;
    limit: number;
  }): Promise<DropshipExpiringPaymentHoldRecord[]> {
    const result = await this.dbPool.query<ExpiredPaymentHoldRow>(
      `SELECT id, vendor_id, store_connection_id, external_order_id,
              payment_hold_expires_at, cancellation_status
       FROM dropship.dropship_order_intake
       WHERE status = 'payment_hold'
         AND payment_hold_expires_at IS NOT NULL
         AND payment_hold_expires_at > $1
         AND payment_hold_expires_at <= $1 + ($2::text)::interval
       ORDER BY payment_hold_expires_at ASC, id ASC
       LIMIT $3`,
      [input.now, `${input.warningWindowMinutes} minutes`, input.limit],
    );
    return result.rows.map(mapExpiringPaymentHoldRow);
  }

  async expirePaymentHolds(input: {
    now: Date;
    limit: number;
    workerId: string;
  }): Promise<DropshipExpiredPaymentHoldRecord[]> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ExpiredPaymentHoldRow>(
        `WITH candidates AS (
           SELECT id
           FROM dropship.dropship_order_intake
           WHERE status = 'payment_hold'
             AND payment_hold_expires_at IS NOT NULL
             AND payment_hold_expires_at <= $1
           ORDER BY payment_hold_expires_at ASC, id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE dropship.dropship_order_intake AS oi
         SET status = 'cancelled',
             cancellation_status = $3,
             rejection_reason = $4,
             updated_at = $1
         FROM candidates
         WHERE oi.id = candidates.id
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.external_order_id,
                   oi.payment_hold_expires_at, oi.cancellation_status`,
        [input.now, input.limit, PAYMENT_HOLD_EXPIRED_STATUS, PAYMENT_HOLD_EXPIRED_REASON],
      );

      for (const row of result.rows) {
        await recordPaymentHoldExpirationAuditEvent(client, {
          row,
          workerId: input.workerId,
          occurredAt: input.now,
        });
      }

      await client.query("COMMIT");
      return result.rows.map(mapExpiredPaymentHoldRow);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function recordPaymentHoldExpirationAuditEvent(
  client: PoolClient,
  input: {
    row: ExpiredPaymentHoldRow;
    workerId: string;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, 'order_payment_hold_expired',
             'job', $4, 'warning', $5::jsonb, $6)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.workerId,
      JSON.stringify({
        previousStatus: "payment_hold",
        cancellationStatus: PAYMENT_HOLD_EXPIRED_STATUS,
        externalOrderId: input.row.external_order_id,
        paymentHoldExpiresAt: input.row.payment_hold_expires_at.toISOString(),
        reason: PAYMENT_HOLD_EXPIRED_REASON,
      }),
      input.occurredAt,
    ],
  );
}

function mapExpiredPaymentHoldRow(row: ExpiredPaymentHoldRow): DropshipExpiredPaymentHoldRecord {
  return {
    intakeId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    externalOrderId: row.external_order_id,
    paymentHoldExpiresAt: row.payment_hold_expires_at,
    cancellationStatus: PAYMENT_HOLD_EXPIRED_STATUS,
  };
}

function mapExpiringPaymentHoldRow(row: ExpiredPaymentHoldRow): DropshipExpiringPaymentHoldRecord {
  return {
    intakeId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    externalOrderId: row.external_order_id,
    paymentHoldExpiresAt: row.payment_hold_expires_at,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
