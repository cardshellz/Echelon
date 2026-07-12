import { z } from "zod";

export const AUTO_DRAFT_RUN_LEASE_MS = 30 * 60 * 1_000;

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});

const runProgressSchema = z.object({
  itemsAnalyzed: nonnegativeSafeInteger,
  skippedNoVendor: nonnegativeSafeInteger,
  skippedOnOrder: nonnegativeSafeInteger,
  skippedExcluded: nonnegativeSafeInteger,
  summaryJson: z.record(z.unknown()).nullable(),
}).strict();

export const autoDraftRunCompletionSchema = runProgressSchema.extend({
  summaryJson: z.record(z.unknown()),
}).strict();

const startRunSchema = z.object({
  triggeredBy: z.enum(["scheduler", "manual"]),
  triggeredByUser: z.string().trim().min(1).max(255).nullable().optional(),
}).strict();

const heartbeatSchema = z.object({
  runId: positiveSafeInteger,
}).strict();

const completeRunSchema = z.object({
  runId: positiveSafeInteger,
  completion: autoDraftRunCompletionSchema,
}).strict();

const failRunSchema = z.object({
  runId: positiveSafeInteger,
  errorMessage: z.string().trim().min(1).max(4_000),
  progress: runProgressSchema,
}).strict();

export type AutoDraftRunStatus = "running" | "success" | "error" | "interrupted";
export type AutoDraftRunCompletion = z.infer<typeof autoDraftRunCompletionSchema>;
export type AutoDraftRunProgress = z.infer<typeof runProgressSchema>;

export interface AutoDraftRunRecord {
  id: number;
  runAt: Date;
  triggeredBy: "scheduler" | "manual";
  triggeredByUser: string | null;
  status: AutoDraftRunStatus;
  heartbeatAt: Date;
  leaseExpiresAt: Date | null;
  itemsAnalyzed: number;
  posCreated: number;
  posUpdated: number;
  linesAdded: number;
  skippedNoVendor: number;
  skippedOnOrder: number;
  skippedExcluded: number;
  errorMessage: string | null;
  summaryJson: unknown;
  finishedAt: Date | null;
}

export interface AutoDraftRunTerminalValues extends AutoDraftRunProgress {
  status: "success" | "error";
  posCreated: number;
  posUpdated: number;
  linesAdded: number;
  errorMessage: string | null;
  finishedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: null;
}

export interface AutoDraftRunLifecycleUnitOfWork {
  lockClaims(): Promise<void>;
  getDatabaseTimestamp(): Promise<Date>;
  getRunningRunsForUpdate(): Promise<AutoDraftRunRecord[]>;
  getRunForUpdate(id: number): Promise<AutoDraftRunRecord | null>;
  interruptRuns(ids: readonly number[], values: {
    finishedAt: Date;
    heartbeatAt: Date;
    errorMessage: string;
  }): Promise<AutoDraftRunRecord[]>;
  createRun(values: {
    runAt: Date;
    triggeredBy: "scheduler" | "manual";
    triggeredByUser: string | null;
    status: "running";
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }): Promise<AutoDraftRunRecord>;
  renewRun(id: number, values: { heartbeatAt: Date; leaseExpiresAt: Date }): Promise<AutoDraftRunRecord | null>;
  finishRun(id: number, values: AutoDraftRunTerminalValues): Promise<AutoDraftRunRecord | null>;
}

export interface AutoDraftRunLifecycleRepository {
  transaction<T>(work: (unitOfWork: AutoDraftRunLifecycleUnitOfWork) => Promise<T>): Promise<T>;
}

export class AutoDraftRunLifecycleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AutoDraftRunLifecycleError";
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AutoDraftRunLifecycleError(
      parsed.error.issues[0]?.message ?? "Invalid auto-draft run input",
      400,
      code,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function addLease(timestamp: Date, leaseMs: number): Date {
  const deadlineMs = timestamp.getTime() + leaseMs;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new AutoDraftRunLifecycleError(
      "The auto-draft lease deadline exceeds the supported timestamp range",
      500,
      "AUTO_DRAFT_RUN_LEASE_RANGE_INVALID",
    );
  }
  return new Date(deadlineMs);
}

function runLeaseDeadline(run: AutoDraftRunRecord, leaseMs: number): Date {
  const deadline = run.leaseExpiresAt ?? addLease(run.runAt, leaseMs);
  if (Number.isNaN(deadline.getTime())) {
    throw new AutoDraftRunLifecycleError(
      "An active auto-draft run has an invalid lease deadline",
      500,
      "AUTO_DRAFT_RUN_LEASE_INVALID",
      { runId: run.id },
    );
  }
  return deadline;
}

function isSingleRunningConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    const constraint = typeof candidate.constraint === "string"
      ? candidate.constraint
      : typeof candidate.constraint_name === "string"
        ? candidate.constraint_name
        : null;
    if (candidate.code === "23505" && constraint === "auto_draft_runs_single_running_uidx") return true;
    current = candidate.cause;
  }
  return false;
}

export function createAutoDraftRunLifecycleService(
  repository: AutoDraftRunLifecycleRepository,
  options: { leaseMs?: number } = {},
) {
  const leaseMs = options.leaseMs ?? AUTO_DRAFT_RUN_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1_000) {
    throw new RangeError("leaseMs must be a positive safe integer no greater than 24 hours");
  }

  async function startRun(input: unknown): Promise<{
    run: AutoDraftRunRecord;
    interruptedRunIds: number[];
  }> {
    const parsed = parseInput(startRunSchema, input, "INVALID_AUTO_DRAFT_RUN_START");

    try {
      return await repository.transaction(async (unitOfWork) => {
        await unitOfWork.lockClaims();
        const now = await unitOfWork.getDatabaseTimestamp();
        const running = await unitOfWork.getRunningRunsForUpdate();
        const expired = running.filter((run) => runLeaseDeadline(run, leaseMs).getTime() <= now.getTime());
        const expiredIds = expired.map((run) => run.id);

        if (expiredIds.length > 0) {
          const interrupted = await unitOfWork.interruptRuns(expiredIds, {
            finishedAt: now,
            heartbeatAt: now,
            errorMessage: "Auto-draft run lease expired before completion and was reclaimed by a later run.",
          });
          if (interrupted.length !== expiredIds.length) {
            throw new AutoDraftRunLifecycleError(
              "Expired auto-draft run ownership changed during reclamation",
              409,
              "AUTO_DRAFT_RUN_RECLAIM_CONFLICT",
              { expiredRunIds: expiredIds, interruptedRunIds: interrupted.map((run) => run.id) },
            );
          }
        }

        const active = running.filter((run) => !expiredIds.includes(run.id));
        if (active.length > 0) {
          const current = active[0];
          throw new AutoDraftRunLifecycleError(
            "An auto-draft run is already active",
            409,
            "AUTO_DRAFT_RUN_ALREADY_RUNNING",
            {
              runId: current.id,
              runAt: current.runAt.toISOString(),
              heartbeatAt: current.heartbeatAt.toISOString(),
              leaseExpiresAt: runLeaseDeadline(current, leaseMs).toISOString(),
            },
          );
        }

        const run = await unitOfWork.createRun({
          runAt: now,
          triggeredBy: parsed.triggeredBy,
          triggeredByUser: parsed.triggeredByUser ?? null,
          status: "running",
          heartbeatAt: now,
          leaseExpiresAt: addLease(now, leaseMs),
        });
        return { run, interruptedRunIds: expiredIds };
      });
    } catch (error) {
      if (isSingleRunningConflict(error)) {
        throw new AutoDraftRunLifecycleError(
          "An auto-draft run is already active",
          409,
          "AUTO_DRAFT_RUN_ALREADY_RUNNING",
        );
      }
      throw error;
    }
  }

  async function heartbeatRun(input: unknown): Promise<AutoDraftRunRecord> {
    const parsed = parseInput(heartbeatSchema, input, "INVALID_AUTO_DRAFT_RUN_HEARTBEAT");
    return repository.transaction(async (unitOfWork) => {
      await unitOfWork.lockClaims();
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") {
        throw new AutoDraftRunLifecycleError(
          "The auto-draft run no longer owns an active lease",
          409,
          "AUTO_DRAFT_RUN_LEASE_LOST",
          { runId: parsed.runId, status: run?.status ?? null },
        );
      }
      const renewed = await unitOfWork.renewRun(run.id, {
        heartbeatAt: now,
        leaseExpiresAt: addLease(now, leaseMs),
      });
      if (!renewed) {
        throw new AutoDraftRunLifecycleError(
          "The auto-draft run lease changed before it could be renewed",
          409,
          "AUTO_DRAFT_RUN_LEASE_LOST",
          { runId: parsed.runId },
        );
      }
      return renewed;
    });
  }

  async function completeRun(input: unknown): Promise<AutoDraftRunRecord> {
    const parsed = parseInput(completeRunSchema, input, "INVALID_AUTO_DRAFT_RUN_COMPLETION");
    return repository.transaction(async (unitOfWork) => {
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") {
        throw new AutoDraftRunLifecycleError(
          "The auto-draft run cannot be completed because its active lease was lost",
          409,
          "AUTO_DRAFT_RUN_LEASE_LOST",
          { runId: parsed.runId, status: run?.status ?? null },
        );
      }
      const completed = await unitOfWork.finishRun(run.id, {
        ...parsed.completion,
        status: "success",
        posCreated: 0,
        posUpdated: 0,
        linesAdded: 0,
        errorMessage: null,
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
      });
      if (!completed) {
        throw new AutoDraftRunLifecycleError(
          "The auto-draft run changed before completion",
          409,
          "AUTO_DRAFT_RUN_LEASE_LOST",
          { runId: parsed.runId },
        );
      }
      return completed;
    });
  }

  async function failRun(input: unknown): Promise<{
    run: AutoDraftRunRecord | null;
    transitioned: boolean;
  }> {
    const parsed = parseInput(failRunSchema, input, "INVALID_AUTO_DRAFT_RUN_FAILURE");
    return repository.transaction(async (unitOfWork) => {
      const now = await unitOfWork.getDatabaseTimestamp();
      const run = await unitOfWork.getRunForUpdate(parsed.runId);
      if (!run || run.status !== "running") return { run, transitioned: false };
      const failed = await unitOfWork.finishRun(run.id, {
        ...parsed.progress,
        status: "error",
        posCreated: run.posCreated,
        posUpdated: run.posUpdated,
        linesAdded: run.linesAdded,
        errorMessage: parsed.errorMessage,
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
      });
      return { run: failed, transitioned: failed !== null };
    });
  }

  return { startRun, heartbeatRun, completeRun, failRun };
}

export type AutoDraftRunLifecycleService = ReturnType<typeof createAutoDraftRunLifecycleService>;
