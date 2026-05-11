import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipWorkerOpsRepository,
  DropshipWorkerSweepMetrics,
  DropshipWorkerSweepName,
  RunDropshipWorkerSweepInput,
} from "../application/dropship-worker-ops-service";

export class PgDropshipWorkerOpsRepository implements DropshipWorkerOpsRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async recordWorkerSweep(input: {
    worker: DropshipWorkerSweepName;
    workerId: string;
    batchSize: number | null;
    reason?: string;
    idempotencyKey: string;
    actor: RunDropshipWorkerSweepInput["actor"];
    status: "completed" | "failed";
    metrics: DropshipWorkerSweepMetrics | null;
    errorMessage: string | null;
    now: Date;
  }): Promise<void> {
    await this.dbPool.query(
      `INSERT INTO dropship.dropship_audit_events
        (entity_type, entity_id, event_type, actor_type, actor_id,
         severity, payload, created_at)
       VALUES ('dropship_worker_sweep', $1, 'worker_sweep_requested',
               $2, $3, $4, $5::jsonb, $6)`,
      [
        input.worker,
        input.actor.actorType,
        input.actor.actorId ?? null,
        input.status === "completed" ? "info" : "error",
        JSON.stringify({
          worker: input.worker,
          workerId: input.workerId,
          batchSize: input.batchSize,
          reason: input.reason ?? null,
          idempotencyKey: input.idempotencyKey,
          status: input.status,
          metrics: input.metrics,
          errorMessage: input.errorMessage,
        }),
        input.now,
      ],
    );
  }
}
