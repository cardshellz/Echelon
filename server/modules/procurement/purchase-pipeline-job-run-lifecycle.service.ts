import { z } from "zod";

export const PURCHASE_PIPELINE_JOB_RUN_LEASE_MS = 60 * 60 * 1_000;

export const purchasePipelineJobTypeSchema = z.enum([
  "recommendation_snapshot",
  "forecast_evaluation",
]);
export type PurchasePipelineJobType = z.infer<typeof purchasePipelineJobTypeSchema>;

export type PurchasePipelineJobRunStatus = "running" | "succeeded" | "failed" | "interrupted";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});
const resultJsonSchema = z.record(z.string(), z.unknown());

const startRunSchema = z.object({
  jobType: purchasePipelineJobTypeSchema,
  triggerType: z.enum(["scheduled", "manual"]),
  asOf: z.date(),
}).strict();

const heartbeatRunSchema = z.object({
  runId: positiveSafeInteger,
}).strict();

const snapshotCompletionSchema = z.object({
  jobType: z.literal("recommendation_snapshot"),
  recommendationRunId: positiveSafeInteger,
  recommendationLineCount: nonnegativeSafeInteger,
  forecastObservationCount: nonnegativeSafeInteger,
  resultJson: resultJsonSchema,
}).strict();

const evaluationCompletionSchema = z.object({
  jobType: z.literal("forecast_evaluation"),
  evaluationInsertedCount: nonnegativeSafeInteger,
  evaluationBatchCount: nonnegativeSafeInteger,
  evaluationBacklogMayRemain: z.boolean(),
  resultJson: resultJsonSchema,
}).strict();

const completeRunSchema = z.object({
  runId: positiveSafeInteger,
  completion: z.discriminatedUnion("jobType", [
    snapshotCompletionSchema,
    evaluationCompletionSchema,
  ]),
}).strict();

const failRunSchema = z.object({
  runId: positiveSafeInteger,
  errorCode: z.string().trim().min(1).max(100),
  errorMessage: z.string().trim().min(1).max(2_000),
  resultJson: resultJsonSchema.nullable().optional(),
  evaluationInsertedCount: nonnegativeSafeInteger.nullable().optional(),
  evaluationBatchCount: nonnegativeSafeInteger.nullable().optional(),
  evaluationBacklogMayRemain: z.boolean().nullable().optional(),
}).strict();

export type PurchasePipelineJobRunRecord = {
  id: number;
  jobType: PurchasePipelineJobType;
  triggerType: "scheduled" | "manual";
  status: PurchasePipelineJobRunStatus;
  asOf: Date;
  startedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date | null;
  finishedAt: Date | null;
  recommendationRunId: number | null;
  recommendationLineCount: number | null;
  forecastObservationCount: number | null;
  evaluationInsertedCount: number | null;
  evaluationBatchCount: number | null;
  evaluationBacklogMayRemain: boolean | null;
  resultJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PurchasePipelineJobRunTerminalValues = {
  status: "succeeded" | "failed";
  heartbeatAt: Date;
  leaseExpiresAt: null;
  finishedAt: Date;
  recommendationRunId: number | null;
  recommendationLineCount: number | null;
  forecastObservationCount: number | null;
  evaluationInsertedCount: number | null;
  evaluationBatchCount: number | null;
  evaluationBacklogMayRemain: boolean | null;
  resultJson: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: Date;
};

export interface PurchasePipelineJobRunLifecycleUnitOfWork {
  lockClaims(jobType: PurchasePipelineJobType): Promise<void>;
  getDatabaseTimestamp(): Promise<Date>;
  getRunningRunsForUpdate(jobType: PurchasePipelineJobType): Promise<PurchasePipelineJobRunRecord[]>;
  getRunForUpdate(id: number): Promise<PurchasePipelineJobRunRecord | null>;
  interruptRuns(ids: readonly number[], values: {
    finishedAt: Date;
    heartbeatAt: Date;
    errorCode: string;
    errorMessage: string;
    updatedAt: Date;
  }): Promise<PurchasePipelineJobRunRecord[]>;
  createRun(values: {
    jobType: PurchasePipelineJobType;
    triggerType: "scheduled" | "manual";
    status: "running";
    asOf: Date;
    startedAt: Date;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }): Promise<PurchasePipelineJobRunRecord>;
  renewRun(id: number, values: {
    heartbeatAt: Date;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }): Promise<PurchasePipelineJobRunRecord | null>;
  finishRun(
    id: number,
    values: PurchasePipelineJobRunTerminalValues,
  ): Promise<PurchasePipelineJobRunRecord | null>;
}

export interface PurchasePipelineJobRunLifecycleRepository {
  transaction<T>(
    work: (unitOfWork: PurchasePipelineJobRunLifecycleUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export class PurchasePipelineJobRunLifecycleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PurchasePipelineJobRunLifecycleError";
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new PurchasePipelineJobRunLifecycleError(
      parsed.error.issues[0]?.message ?? "Invalid purchase pipeline job input",
      400,
      code,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PurchasePipelineJobRunLifecycleError(
      `${field} must be a valid date`,
      400,
      "INVALID_PURCHASE_PIPELINE_JOB_DATE",
      { field },
    );
  }
  return new Date(value.getTime());
}

function addLease(timestamp: Date, leaseMs: number): Date {
  const deadlineMs = timestamp.getTime() + leaseMs;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new PurchasePipelineJobRunLifecycleError(
      "The purchase pipeline job lease exceeds the supported timestamp range",
      500,
      "PURCHASE_PIPELINE_JOB_LEASE_RANGE_INVALID",
    );
  }
  return new Date(deadlineMs);
}

function leaseDeadline(run: PurchasePipelineJobRunRecord, leaseMs: number): Date {
  const deadline = run.leaseExpiresAt ?? addLease(run.heartbeatAt, leaseMs);
  if (Number.isNaN(deadline.getTime())) {
    throw new PurchasePipelineJobRunLifecycleError(
      "An active purchase pipeline job has an invalid lease deadline",
      500,
      "PURCHASE_PIPELINE_JOB_LEASE_INVALID",
      { runId: run.id },
    );
  }
  return deadline;
}

function isSingleRunningConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    const constraint = typeof candidate.constraint === "string"
      ? candidate.constraint
      : typeof candidate.constraint_name === "string"
        ? candidate.constraint_name
        : null;
    if (
      candidate.code === "23505"
      && constraint === "purchase_pipeline_job_runs_single_running_uidx"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function assertJobType(
  run: PurchasePipelineJobRunRecord,
  jobType: PurchasePipelineJobType,
): void {
  if (run.jobType !== jobType) {
    throw new PurchasePipelineJobRunLifecycleError(
      "The completion payload does not match the claimed purchase pipeline job",
      409,
      "PURCHASE_PIPELINE_JOB_TYPE_MISMATCH",
      { runId: run.id, expectedJobType: run.jobType, actualJobType: jobType },
    );
  }
}

export function sanitizePurchasePipelineJobError(error: unknown): {
  errorCode: string;
  errorMessage: string;
} {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; name?: unknown; message?: unknown }
    : null;
  const rawCode = typeof candidate?.code === "string"
    ? candidate.code
    : typeof candidate?.name === "string"
      ? candidate.name
      : "PURCHASE_PIPELINE_JOB_FAILED";
  const errorCode = rawCode
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 100) || "PURCHASE_PIPELINE_JOB_FAILED";
  const rawMessage = typeof candidate?.message === "string"
    ? candidate.message
    : typeof error === "string"
      ? error
      : "Purchase pipeline job failed";
  const errorMessage = rawMessage
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(password|token|secret|api[_-]?key)\s*([=:])\s*[^\s,;]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000) || "Purchase pipeline job failed";
  return { errorCode, errorMessage };
}

export function createPurchasePipelineJobRunLifecycleService(
  repository: PurchasePipelineJobRunLifecycleRepository,
  options: { leaseMs?: number } = {},
) {
  const leaseMs = options.leaseMs ?? PURCHASE_PIPELINE_JOB_RUN_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1_000) {
    throw new RangeError("leaseMs must be a positive safe integer no greater than 24 hours");
  }

  async function startRun(input: unknown): Promise<{
    run: PurchasePipelineJobRunRecord;
    interruptedRunIds: number[];
  }> {
    const parsed = parseInput(startRunSchema, input, "INVALID_PURCHASE_PIPELINE_JOB_START");
    const asOf = validDate(parsed.asOf, "asOf");

    try {
      return await repository.transaction(async (unitOfWork) => {
        await unitOfWork.lockClaims(parsed.jobType);
        const now = await unitOfWork.getDatabaseTimestamp();
        const running = await unitOfWork.getRunningRunsForUpdate(parsed.jobType);
        const expired = running.filter(
          (run) => leaseDeadline(run, leaseMs).getTime() <= now.getTime(),
        );
        const expiredIds = expired.map((run) => run.id);

        if (expiredIds.length > 0) {
          const interrupted = await unitOfWork.interruptRuns(expiredIds, {
            finishedAt: now,
            heartbeatAt: now,
            errorCode: "PURCHASE_PIPELINE_JOB_LEASE_EXPIRED",
            errorMessage:
              "The purchase pipeline job lease expired before completion and was reclaimed.",
            updatedAt: now,
          });
          if (interrupted.length !== expiredIds.length) {
            throw new PurchasePipelineJobRunLifecycleError(
              "Expired purchase pipeline job ownership changed during reclamation",
              409,
              "PURCHASE_PIPELINE_JOB_RECLAIM_CONFLICT",
              { expiredRunIds: expiredIds, interruptedRunIds: interrupted.map((run) => run.id) },
            );
          }
        }

        const active = running.filter((run) => !expiredIds.includes(run.id));
        if (active.length > 0) {
          const current = active[0]!;
          throw new PurchasePipelineJobRunLifecycleError(
            "A purchase pipeline job of this type is already running",
            409,
            "PURCHASE_PIPELINE_JOB_ALREADY_RUNNING",
            {
              runId: current.id,
              jobType: current.jobType,
              heartbeatAt: current.heartbeatAt.toISOString(),
              leaseExpiresAt: leaseDeadline(current, leaseMs).toISOString(),
            },
          );
        }

        const run = await unitOfWork.createRun({
          jobType: parsed.jobType,
          triggerType: parsed.triggerType,
          status: "running",
          asOf,
          startedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: addLease(now, leaseMs),
          updatedAt: now,
        });
        return { run, interruptedRunIds: expiredIds };
      });
    } catch (error) {
      if (isSingleRunningConflict(error)) {
        throw new PurchasePipelineJobRunLifecycleError(
          "A purchase pipeline job of this type is already running",
          409,
          "PURCHASE_PIPELINE_JOB_ALREADY_RUNNING",
          { jobType: parsed.jobType },
        );
      }
      throw error;
    }
  }

  async function heartbeatRun(input: unknown): Promise<PurchasePipelineJobRunRecord> {
    const parsed = parseInput(
      heartbeatRunSchema,
      input,
      "INVALID_PURCHASE_PIPELINE_JOB_HEARTBEAT",
    );
    return repository.transaction(async (unitOfWork) => {
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job no longer owns an active lease",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: parsed.runId, status: run?.status ?? null },
        );
      }
      if (leaseDeadline(run, leaseMs).getTime() <= now.getTime()) {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job lease expired before it could be renewed",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: run.id, leaseExpiresAt: leaseDeadline(run, leaseMs).toISOString() },
        );
      }
      const renewed = await unitOfWork.renewRun(run.id, {
        heartbeatAt: now,
        leaseExpiresAt: addLease(now, leaseMs),
        updatedAt: now,
      });
      if (!renewed) {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job lease changed before it could be renewed",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: parsed.runId },
        );
      }
      return renewed;
    });
  }

  async function completeRun(input: unknown): Promise<PurchasePipelineJobRunRecord> {
    const parsed = parseInput(
      completeRunSchema,
      input,
      "INVALID_PURCHASE_PIPELINE_JOB_COMPLETION",
    );
    return repository.transaction(async (unitOfWork) => {
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job cannot complete because its active lease was lost",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: parsed.runId, status: run?.status ?? null },
        );
      }
      if (leaseDeadline(run, leaseMs).getTime() <= now.getTime()) {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job lease expired before completion",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: run.id, leaseExpiresAt: leaseDeadline(run, leaseMs).toISOString() },
        );
      }
      assertJobType(run, parsed.completion.jobType);
      const values: PurchasePipelineJobRunTerminalValues = parsed.completion.jobType
        === "recommendation_snapshot"
        ? {
            status: "succeeded",
            heartbeatAt: now,
            leaseExpiresAt: null,
            finishedAt: now,
            recommendationRunId: parsed.completion.recommendationRunId,
            recommendationLineCount: parsed.completion.recommendationLineCount,
            forecastObservationCount: parsed.completion.forecastObservationCount,
            evaluationInsertedCount: null,
            evaluationBatchCount: null,
            evaluationBacklogMayRemain: null,
            resultJson: parsed.completion.resultJson,
            errorCode: null,
            errorMessage: null,
            updatedAt: now,
          }
        : {
            status: "succeeded",
            heartbeatAt: now,
            leaseExpiresAt: null,
            finishedAt: now,
            recommendationRunId: null,
            recommendationLineCount: null,
            forecastObservationCount: null,
            evaluationInsertedCount: parsed.completion.evaluationInsertedCount,
            evaluationBatchCount: parsed.completion.evaluationBatchCount,
            evaluationBacklogMayRemain: parsed.completion.evaluationBacklogMayRemain,
            resultJson: parsed.completion.resultJson,
            errorCode: null,
            errorMessage: null,
            updatedAt: now,
          };
      const completed = await unitOfWork.finishRun(run.id, values);
      if (!completed) {
        throw new PurchasePipelineJobRunLifecycleError(
          "The purchase pipeline job changed before completion",
          409,
          "PURCHASE_PIPELINE_JOB_LEASE_LOST",
          { runId: parsed.runId },
        );
      }
      return completed;
    });
  }

  async function failRun(input: unknown): Promise<{
    run: PurchasePipelineJobRunRecord | null;
    transitioned: boolean;
  }> {
    const parsed = parseInput(failRunSchema, input, "INVALID_PURCHASE_PIPELINE_JOB_FAILURE");
    const failure = sanitizePurchasePipelineJobError({
      code: parsed.errorCode,
      message: parsed.errorMessage,
    });
    return repository.transaction(async (unitOfWork) => {
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") return { run, transitioned: false };
      const failed = await unitOfWork.finishRun(run.id, {
        status: "failed",
        heartbeatAt: now,
        leaseExpiresAt: null,
        finishedAt: now,
        recommendationRunId: null,
        recommendationLineCount: null,
        forecastObservationCount: null,
        evaluationInsertedCount: parsed.evaluationInsertedCount ?? null,
        evaluationBatchCount: parsed.evaluationBatchCount ?? null,
        evaluationBacklogMayRemain: parsed.evaluationBacklogMayRemain ?? null,
        resultJson: parsed.resultJson ?? null,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        updatedAt: now,
      });
      return { run: failed, transitioned: failed !== null };
    });
  }

  return { startRun, heartbeatRun, completeRun, failRun };
}

export type PurchasePipelineJobRunLifecycleService = ReturnType<
  typeof createPurchasePipelineJobRunLifecycleService
>;
