import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipOrderCancellationServiceFromEnv } from "./dropship-order-cancellation.factory";
import { createDropshipOrderProcessingServiceFromEnv } from "./dropship-order-processing.factory";
import { createDropshipPaymentHoldExpirationServiceFromEnv } from "./dropship-payment-hold-expiration.factory";
import {
  DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES,
  type DropshipPaymentHoldExpirationService,
} from "../application/dropship-payment-hold-expiration-service";
import type { DropshipOrderCancellationService } from "../application/dropship-order-cancellation-service";
import type { DropshipOrderProcessingResult } from "../application/dropship-order-processing-service";

export interface DropshipOrderProcessingQueueRepository {
  recoverStaleProcessingIntakes(input: {
    limit: number;
    now: Date;
    staleAfterMinutes: number;
    workerId: string;
  }): Promise<number[]>;

  listProcessableIntakeIds(input: {
    limit: number;
    now: Date;
  }): Promise<number[]>;
}

interface IntakeIdRow {
  id: number;
}

interface StaleProcessingIntakeRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  external_order_id: string;
  stale_updated_at: Date;
}

type DropshipPaymentHoldExpirationSweepService = Pick<
  DropshipPaymentHoldExpirationService,
  "expireExpiredPaymentHolds" | "notifyExpiringPaymentHolds"
>;

type DropshipOrderCancellationSweepService = Pick<
  DropshipOrderCancellationService,
  "processPendingCancellations"
>;

interface DropshipOrderProcessingSweepService {
  processIntake(input: {
    intakeId: number;
    workerId: string;
    idempotencyKey: string;
  }): Promise<DropshipOrderProcessingResult>;
}

const DROPSHIP_ORDER_PROCESSING_WORKER_LOCK_ID = 736205;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_STALE_PROCESSING_MINUTES = 30;

export class PgDropshipOrderProcessingQueueRepository implements DropshipOrderProcessingQueueRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async recoverStaleProcessingIntakes(input: {
    limit: number;
    now: Date;
    staleAfterMinutes: number;
    workerId: string;
  }): Promise<number[]> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<StaleProcessingIntakeRow>(
        `WITH candidates AS (
           SELECT id, updated_at AS stale_updated_at
           FROM dropship.dropship_order_intake
           WHERE status = 'processing'
             AND updated_at <= $1::timestamptz - ($2::text)::interval
           ORDER BY updated_at ASC, id ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         UPDATE dropship.dropship_order_intake AS oi
         SET status = 'retrying',
             rejection_reason = 'Recovered stale order processing claim.',
             updated_at = $1
         FROM candidates
         WHERE oi.id = candidates.id
         RETURNING oi.id, oi.vendor_id, oi.store_connection_id, oi.external_order_id,
                   candidates.stale_updated_at`,
        [input.now, `${input.staleAfterMinutes} minutes`, input.limit],
      );

      for (const row of result.rows) {
        await recordStaleProcessingRecoveryAuditEvent(client, {
          row,
          workerId: input.workerId,
          staleAfterMinutes: input.staleAfterMinutes,
          occurredAt: input.now,
        });
      }

      await client.query("COMMIT");
      return result.rows.map((row) => row.id);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listProcessableIntakeIds(input: {
    limit: number;
    now: Date;
  }): Promise<number[]> {
    // Revisit a hold only after its vendor wallet changes; reprocessing moves the
    // intake timestamp forward so the same wallet mutation cannot trigger it again.
    const result = await this.dbPool.query<IntakeIdRow>(
      `SELECT oi.id
       FROM dropship.dropship_order_intake oi
       WHERE oi.status IN ('received', 'retrying')
          OR (
            oi.status = 'payment_hold'
            AND oi.payment_hold_expires_at > $2
            AND EXISTS (
              SELECT 1
              FROM dropship.dropship_wallet_accounts wa
              WHERE wa.vendor_id = oi.vendor_id
                AND wa.updated_at >= oi.updated_at
            )
          )
       ORDER BY oi.received_at ASC, oi.id ASC
       LIMIT $1`,
      [input.limit, input.now],
    );
    return result.rows.map((row) => row.id);
  }
}

export async function runDropshipOrderProcessingIntake(input: {
  intakeId: number;
  workerId?: string;
  idempotencyKey?: string;
}): Promise<DropshipOrderProcessingResult> {
  const workerId = input.workerId ?? defaultWorkerId();
  return createDropshipOrderProcessingServiceFromEnv().processIntake({
    intakeId: input.intakeId,
    workerId,
    idempotencyKey: input.idempotencyKey ?? defaultOrderProcessingIdempotencyKey(input.intakeId),
  });
}

export async function runDropshipOrderProcessingSweep(input: {
  repository?: DropshipOrderProcessingQueueRepository;
  paymentHoldExpirationService?: DropshipPaymentHoldExpirationSweepService;
  orderCancellationService?: DropshipOrderCancellationSweepService;
  orderProcessingService?: DropshipOrderProcessingSweepService;
  batchSize?: number;
  staleProcessingMinutes?: number;
  workerId?: string;
  now?: Date;
} = {}): Promise<{
  processed: number;
  failed: number;
  skipped: number;
  expired: number;
  expiringNotified: number;
  cancellationSucceeded: number;
  cancellationRetrying: number;
  cancellationFailed: number;
  staleProcessingRecovered: number;
}> {
  const repository = input.repository ?? new PgDropshipOrderProcessingQueueRepository();
  const batchSize = input.batchSize ?? envPositiveInteger("DROPSHIP_ORDER_PROCESSING_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const staleProcessingMinutes = input.staleProcessingMinutes
    ?? envPositiveInteger("DROPSHIP_ORDER_PROCESSING_STALE_PROCESSING_MINUTES", DEFAULT_STALE_PROCESSING_MINUTES);
  const workerId = input.workerId ?? defaultWorkerId();
  const now = input.now ?? new Date();
  const paymentHoldExpirationService = input.paymentHoldExpirationService
    ?? createDropshipPaymentHoldExpirationServiceFromEnv();
  const expiration = await paymentHoldExpirationService.expireExpiredPaymentHolds({
    limit: batchSize,
    workerId,
  });
  const expiring = await paymentHoldExpirationService.notifyExpiringPaymentHolds({
    limit: batchSize,
    workerId,
    warningWindowMinutes: envPositiveInteger(
      "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
      DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES,
    ),
  });
  const cancellation = await (
    input.orderCancellationService ?? createDropshipOrderCancellationServiceFromEnv()
  ).processPendingCancellations({
    limit: batchSize,
    workerId,
  });
  const recoveredStaleIntakeIds = await repository.recoverStaleProcessingIntakes({
    limit: batchSize,
    now,
    staleAfterMinutes: staleProcessingMinutes,
    workerId,
  });
  let expired = expiration.expiredCount;
  const intakeIds = await repository.listProcessableIntakeIds({ limit: batchSize, now });
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const service = input.orderProcessingService ?? createDropshipOrderProcessingServiceFromEnv();

  for (const intakeId of intakeIds) {
    try {
      const result = await service.processIntake({
        intakeId,
        workerId,
        idempotencyKey: defaultOrderProcessingIdempotencyKey(intakeId),
      });
      if (result.outcome === "skipped") {
        skipped += 1;
      } else if (result.outcome === "cancelled") {
        expired += 1;
      } else if (result.outcome === "failed") {
        failed += 1;
      } else {
        processed += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        code: "DROPSHIP_ORDER_PROCESSING_SWEEP_INTAKE_FAILED",
        message: "Dropship order processing sweep failed to process an intake.",
        context: {
          intakeId,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }

  return {
    processed,
    failed,
    skipped,
    expired,
    expiringNotified: expiring.notifiedCount,
    cancellationSucceeded: cancellation.succeeded,
    cancellationRetrying: cancellation.retrying,
    cancellationFailed: cancellation.failed,
    staleProcessingRecovered: recoveredStaleIntakeIds.length,
  };
}

export function startDropshipOrderProcessingWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_ORDER_PROCESSING_WORKER_DISABLED === "true"
    || process.env.DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED !== "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_ORDER_PROCESSING_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_ORDER_PROCESSING_WORKER_LOCK_ID, async () => {
        const result = await runDropshipOrderProcessingSweep();
        if (
          result.processed > 0
          || result.failed > 0
          || result.skipped > 0
          || result.expired > 0
          || result.expiringNotified > 0
          || result.cancellationSucceeded > 0
          || result.cancellationRetrying > 0
          || result.cancellationFailed > 0
          || result.staleProcessingRecovered > 0
        ) {
          console.info(JSON.stringify({
            code: "DROPSHIP_ORDER_PROCESSING_SWEEP_COMPLETED",
            message: "Dropship order processing sweep completed.",
            context: result,
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_ORDER_PROCESSING_SWEEP_FAILED",
        message: "Dropship order processing sweep failed.",
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  setTimeout(runLockedSweep, Math.min(intervalMs, 5_000));
  setInterval(runLockedSweep, intervalMs);
  console.info(JSON.stringify({
    code: "DROPSHIP_ORDER_PROCESSING_WORKER_STARTED",
    message: "Dropship order processing worker started.",
    context: { intervalMs },
  }));
}

function defaultWorkerId(): string {
  return `dropship-order-processing-${process.pid}`;
}

function defaultOrderProcessingIdempotencyKey(intakeId: number): string {
  return `dropship-order-processing:intake:${intakeId}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function recordStaleProcessingRecoveryAuditEvent(
  client: PoolClient,
  input: {
    row: StaleProcessingIntakeRow;
    workerId: string;
    staleAfterMinutes: number;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, 'order_processing_stale_recovered',
             'job', $4, 'warning', $5::jsonb, $6)`,
    [
      input.row.vendor_id,
      input.row.store_connection_id,
      String(input.row.id),
      input.workerId,
      JSON.stringify({
        previousStatus: "processing",
        status: "retrying",
        externalOrderId: input.row.external_order_id,
        staleProcessingUpdatedAt: input.row.stale_updated_at.toISOString(),
        staleAfterMinutes: input.staleAfterMinutes,
        reason: "processing claim exceeded stale threshold before completion.",
      }),
      input.occurredAt,
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
