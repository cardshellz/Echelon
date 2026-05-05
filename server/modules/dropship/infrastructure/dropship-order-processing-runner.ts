import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipOrderCancellationServiceFromEnv } from "./dropship-order-cancellation.factory";
import { createDropshipOrderProcessingServiceFromEnv } from "./dropship-order-processing.factory";
import { createDropshipPaymentHoldExpirationServiceFromEnv } from "./dropship-payment-hold-expiration.factory";
import { DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES } from "../application/dropship-payment-hold-expiration-service";
import type { DropshipOrderProcessingResult } from "../application/dropship-order-processing-service";

export interface DropshipOrderProcessingQueueRepository {
  listProcessableIntakeIds(input: {
    limit: number;
    now: Date;
  }): Promise<number[]>;
}

interface IntakeIdRow {
  id: number;
}

const DROPSHIP_ORDER_PROCESSING_WORKER_LOCK_ID = 736205;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 10;

export class PgDropshipOrderProcessingQueueRepository implements DropshipOrderProcessingQueueRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listProcessableIntakeIds(input: {
    limit: number;
    now: Date;
  }): Promise<number[]> {
    const result = await this.dbPool.query<IntakeIdRow>(
      `SELECT id
       FROM dropship.dropship_order_intake
       WHERE status IN ('received', 'retrying')
          OR (
            status = 'payment_hold'
            AND (payment_hold_expires_at IS NULL OR payment_hold_expires_at > $2)
          )
       ORDER BY received_at ASC, id ASC
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
    idempotencyKey: input.idempotencyKey ?? `${workerId}:intake:${input.intakeId}`,
  });
}

export async function runDropshipOrderProcessingSweep(input: {
  repository?: DropshipOrderProcessingQueueRepository;
  batchSize?: number;
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
}> {
  const repository = input.repository ?? new PgDropshipOrderProcessingQueueRepository();
  const batchSize = input.batchSize ?? envPositiveInteger("DROPSHIP_ORDER_PROCESSING_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const workerId = input.workerId ?? defaultWorkerId();
  const now = input.now ?? new Date();
  const paymentHoldExpirationService = createDropshipPaymentHoldExpirationServiceFromEnv();
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
  const cancellation = await createDropshipOrderCancellationServiceFromEnv().processPendingCancellations({
    limit: batchSize,
    workerId,
  });
  let expired = expiration.expiredCount;
  const intakeIds = await repository.listProcessableIntakeIds({ limit: batchSize, now });
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const service = createDropshipOrderProcessingServiceFromEnv();

  for (const intakeId of intakeIds) {
    try {
      const result = await service.processIntake({
        intakeId,
        workerId,
        idempotencyKey: `${workerId}:intake:${intakeId}`,
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

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
