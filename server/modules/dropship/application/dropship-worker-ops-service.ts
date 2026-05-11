import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

const dropshipWorkerSweepNameSchema = z.enum([
  "listing_push",
  "order_processing",
  "ebay_order_intake",
]);

const dropshipWorkerSweepActorSchema = z.object({
  actorType: z.literal("admin"),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

const runDropshipWorkerSweepInputSchema = z.object({
  worker: dropshipWorkerSweepNameSchema,
  batchSize: z.number().int().positive().max(100).optional(),
  reason: z.string().trim().max(1000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  actor: dropshipWorkerSweepActorSchema,
}).strict();

export type DropshipWorkerSweepName = z.infer<typeof dropshipWorkerSweepNameSchema>;
export type RunDropshipWorkerSweepInput = z.infer<typeof runDropshipWorkerSweepInputSchema>;
export type DropshipWorkerSweepMetrics = Record<string, number>;

export interface DropshipWorkerSweepResult {
  worker: DropshipWorkerSweepName;
  workerId: string;
  batchSize: number | null;
  metrics: DropshipWorkerSweepMetrics;
  status: "completed";
  requestedAt: Date;
}

export interface DropshipWorkerSweepRunner {
  run(input: {
    workerId: string;
    batchSize?: number;
  }): Promise<DropshipWorkerSweepMetrics>;
}

export interface DropshipWorkerOpsRepository {
  recordWorkerSweep(input: {
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
  }): Promise<void>;
}

export class DropshipWorkerOpsService {
  constructor(
    private readonly deps: {
      repository: DropshipWorkerOpsRepository;
      runners: Record<DropshipWorkerSweepName, DropshipWorkerSweepRunner>;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runSweep(input: unknown): Promise<DropshipWorkerSweepResult> {
    const parsed = parseRunSweepInput(input);
    const now = this.deps.clock.now();
    const runner = this.deps.runners[parsed.worker];
    if (!runner) {
      throw new DropshipError(
        "DROPSHIP_WORKER_SWEEP_NOT_CONFIGURED",
        "Dropship worker sweep runner is not configured.",
        { worker: parsed.worker },
      );
    }

    const workerId = buildAdminWorkerId(parsed.worker, parsed.actor);
    try {
      const metrics = normalizeMetrics(await runner.run({
        workerId,
        batchSize: parsed.batchSize,
      }));
      await this.deps.repository.recordWorkerSweep({
        worker: parsed.worker,
        workerId,
        batchSize: parsed.batchSize ?? null,
        reason: parsed.reason,
        idempotencyKey: parsed.idempotencyKey,
        actor: parsed.actor,
        status: "completed",
        metrics,
        errorMessage: null,
        now,
      });
      this.deps.logger.info({
        code: "DROPSHIP_WORKER_SWEEP_COMPLETED",
        message: "Dropship worker sweep was run by ops.",
        context: {
          worker: parsed.worker,
          workerId,
          batchSize: parsed.batchSize ?? null,
          metrics,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
      return {
        worker: parsed.worker,
        workerId,
        batchSize: parsed.batchSize ?? null,
        metrics,
        status: "completed",
        requestedAt: now,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.deps.repository.recordWorkerSweep({
        worker: parsed.worker,
        workerId,
        batchSize: parsed.batchSize ?? null,
        reason: parsed.reason,
        idempotencyKey: parsed.idempotencyKey,
        actor: parsed.actor,
        status: "failed",
        metrics: null,
        errorMessage: message,
        now,
      });
      this.deps.logger.error({
        code: "DROPSHIP_WORKER_SWEEP_FAILED",
        message: "Dropship worker sweep failed after an ops request.",
        context: {
          worker: parsed.worker,
          workerId,
          batchSize: parsed.batchSize ?? null,
          error: message,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
      throw new DropshipError(
        "DROPSHIP_WORKER_SWEEP_FAILED",
        "Dropship worker sweep failed.",
        {
          worker: parsed.worker,
          error: message,
        },
      );
    }
  }
}

export function makeDropshipWorkerOpsLogger(): DropshipLogger {
  return {
    info: (event) => logWorkerOpsEvent("info", event),
    warn: (event) => logWorkerOpsEvent("warn", event),
    error: (event) => logWorkerOpsEvent("error", event),
  };
}

export const systemDropshipWorkerOpsClock: DropshipClock = {
  now: () => new Date(),
};

function parseRunSweepInput(input: unknown): RunDropshipWorkerSweepInput {
  const result = runDropshipWorkerSweepInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_WORKER_SWEEP_INVALID_INPUT",
      "Dropship worker sweep input failed validation.",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function normalizeMetrics(metrics: DropshipWorkerSweepMetrics): DropshipWorkerSweepMetrics {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
    if (!Number.isFinite(value)) {
      throw new DropshipError(
        "DROPSHIP_WORKER_SWEEP_INVALID_RESULT",
        "Dropship worker sweep returned a non-finite metric.",
        { key, value },
      );
    }
    return [key, value];
  }));
}

function buildAdminWorkerId(
  worker: DropshipWorkerSweepName,
  actor: RunDropshipWorkerSweepInput["actor"],
): string {
  const actorSuffix = actor.actorId ? `:${actor.actorId}` : "";
  return `dropship-admin-${worker}${actorSuffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWorkerOpsEvent(
  level: "info" | "warn" | "error",
  event: { code: string; message: string; context?: Record<string, unknown> },
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
