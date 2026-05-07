import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipOrderIntakeStatus } from "../application/dropship-order-intake-service";
import type {
  DropshipOrderRejectionRepository,
  DropshipOrderRejectionResult,
} from "../application/dropship-order-rejection-service";
import { DropshipError } from "../domain/errors";
import { isDropshipStoreConnectionLaunchReady } from "../domain/store-connection";

const VENDOR_REJECTABLE_STATUSES = new Set<DropshipOrderIntakeStatus>([
  "received",
  "retrying",
  "failed",
  "payment_hold",
]);
const ORDER_INTAKE_REJECTED_CANCELLATION_STATUS = "order_intake_rejected";

interface RejectionIntakeRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  external_order_id: string;
  external_order_number: string | null;
  status: DropshipOrderIntakeStatus;
  rejection_reason: string | null;
  cancellation_status: string | null;
  oms_order_id: string | number | null;
  updated_at: Date;
}

interface RejectionIntakeContextRow extends RejectionIntakeRow {
  store_platform: string;
  store_status: string;
  setup_status: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
}

export class PgDropshipOrderRejectionRepository implements DropshipOrderRejectionRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async rejectOrder(
    input: Parameters<DropshipOrderRejectionRepository["rejectOrder"]>[0],
  ): Promise<DropshipOrderRejectionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadIntakeForVendorUpdate(client, {
        intakeId: input.intakeId,
        vendorId: input.vendorId,
      });
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_ORDER_REJECTION_INTAKE_NOT_FOUND",
          "Dropship order intake was not found for this vendor.",
          { intakeId: input.intakeId, vendorId: input.vendorId },
        );
      }

      if (isIdempotentRejectedState(existing, input.reason)) {
        await client.query("COMMIT");
        return mapRejectionResult(existing, existing.status, true);
      }

      assertCanRejectIntake(existing);

      const updated = await client.query<RejectionIntakeRow>(
        `UPDATE dropship.dropship_order_intake
         SET status = 'rejected',
             rejection_reason = $3,
             cancellation_status = $4,
             payment_hold_expires_at = NULL,
             updated_at = $5
         WHERE id = $1
           AND vendor_id = $2
         RETURNING id, vendor_id, store_connection_id, external_order_id,
                   external_order_number, status, rejection_reason,
                   cancellation_status, oms_order_id, updated_at`,
        [
          input.intakeId,
          input.vendorId,
          input.reason,
          ORDER_INTAKE_REJECTED_CANCELLATION_STATUS,
          input.rejectedAt,
        ],
      );
      const row = requiredRow(updated.rows[0], "Dropship order rejection update did not return a row.");
      await recordRejectionAuditEvent(client, {
        row,
        previousStatus: existing.status,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actor.actorId ?? null,
        rejectedAt: input.rejectedAt,
      });
      await client.query("COMMIT");
      return mapRejectionResult(row, existing.status, false);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadIntakeForVendorUpdate(
  client: PoolClient,
  input: {
    intakeId: number;
    vendorId: number;
  },
): Promise<RejectionIntakeContextRow | null> {
  const result = await client.query<RejectionIntakeContextRow>(
    `SELECT oi.id, oi.vendor_id, oi.store_connection_id, oi.external_order_id,
            oi.external_order_number, oi.status, oi.rejection_reason,
            oi.cancellation_status, oi.oms_order_id, oi.updated_at,
            sc.platform AS store_platform,
            sc.status AS store_status,
            sc.setup_status,
            sc.access_token_ref,
            sc.refresh_token_ref
     FROM dropship.dropship_order_intake oi
     INNER JOIN dropship.dropship_store_connections sc ON sc.id = oi.store_connection_id
       AND sc.vendor_id = oi.vendor_id
     WHERE oi.id = $1
       AND oi.vendor_id = $2
     LIMIT 1
     FOR UPDATE OF oi, sc`,
    [input.intakeId, input.vendorId],
  );
  return result.rows[0] ?? null;
}

function assertCanRejectIntake(row: RejectionIntakeContextRow): void {
  if (row.oms_order_id !== null) {
    throw new DropshipError(
      "DROPSHIP_ORDER_REJECTION_NOT_ALLOWED",
      "Dropship order intake cannot be rejected after an OMS order has been created.",
      {
        intakeId: row.id,
        status: row.status,
        omsOrderId: row.oms_order_id,
      },
    );
  }

  if (!VENDOR_REJECTABLE_STATUSES.has(row.status)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_REJECTION_NOT_ALLOWED",
      "Dropship order intake status cannot be rejected by the vendor.",
      {
        intakeId: row.id,
        status: row.status,
        cancellationStatus: row.cancellation_status,
      },
    );
  }

  if (!isDropshipStoreConnectionLaunchReady({
    platform: row.store_platform,
    status: row.store_status,
    setupStatus: row.setup_status,
    hasAccessToken: row.access_token_ref !== null,
    hasRefreshToken: row.refresh_token_ref !== null,
  })) {
    throw new DropshipError(
      "DROPSHIP_ORDER_STORE_BLOCKED",
      "Dropship store connection is not launch-ready for order rejection.",
      {
        intakeId: row.id,
        storeConnectionId: row.store_connection_id,
        storeStatus: row.store_status,
        setupStatus: row.setup_status,
      },
    );
  }
}

function isIdempotentRejectedState(row: RejectionIntakeRow, reason: string): boolean {
  return (row.status === "rejected" || row.status === "cancelled")
    && row.rejection_reason === reason
    && row.cancellation_status !== null;
}

async function recordRejectionAuditEvent(
  client: PoolClient,
  input: {
    row: RejectionIntakeRow;
    previousStatus: DropshipOrderIntakeStatus;
    idempotencyKey: string;
    actorId: string | null;
    rejectedAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, 'order_vendor_rejected',
             'vendor', $4, 'warning', $5::jsonb, $6)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.actorId,
      JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        externalOrderId: input.row.external_order_id,
        externalOrderNumber: input.row.external_order_number,
        previousStatus: input.previousStatus,
        status: input.row.status,
        rejectionReason: input.row.rejection_reason,
        cancellationStatus: input.row.cancellation_status,
      }),
      input.rejectedAt,
    ],
  );
}

function mapRejectionResult(
  row: RejectionIntakeRow,
  previousStatus: DropshipOrderIntakeStatus,
  idempotentReplay: boolean,
): DropshipOrderRejectionResult {
  return {
    intakeId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    externalOrderId: row.external_order_id,
    externalOrderNumber: row.external_order_number,
    previousStatus,
    status: row.status,
    cancellationStatus: row.cancellation_status,
    rejectionReason: row.rejection_reason ?? "",
    idempotentReplay,
    rejectedAt: row.updated_at,
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
