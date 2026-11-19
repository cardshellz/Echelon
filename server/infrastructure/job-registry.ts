/**
 * Canonical Scheduled Job Registry (`P1.5`)
 *
 * Every recurring background reconciler/sweeper registers:
 *   - `name`: unique job identifier (persisted in `public.scheduler_runs`)
 *   - `cadenceMs`: non-overlapping completion-to-next-start interval
 *   - `initialDelayMs`: post-boot settle delay before first tick
 *   - `advisoryLockId`: MANDATORY unique 32-bit PostgreSQL session advisory lock key
 *   - `writableStates`: explicit declaration of domain states/tables the job may write
 *   - `deadLetterPolicy`: how unrecoverable item failures are surfaced
 *
 * Exposes live + persisted run state and lock state for `/api/sync/status`.
 */

import {
  startNonOverlappingScheduler,
  type NonOverlappingSchedulerHandle,
} from "./non-overlapping-scheduler";
import {
  getSchedulerDisableReason,
  schedulerIsDisabled,
} from "./scheduler-config";
import {
  getSchedulerLockPoolSnapshot,
  withAdvisoryLock,
} from "./scheduler-lock";
import {
  isBehindSchedule,
  listRecordedSchedulerRuns,
  recordRunCompleted,
} from "./scheduler-run-registry";
import { observeRuntimeWork } from "../platform/observability/runtime-memory";
import { logger, runWithContext } from "../platform/observability";

export type JobDeadLetterPolicy =
  | "review_flag"
  | "webhook_retry_queue"
  | "sync_log"
  | "log_and_retry_next_tick"
  | "none";

export type RegisteredJobOutcome =
  | "never_run"
  | "succeeded"
  | "failed"
  | "skipped_lock_held";

export interface RegisteredJobSpec {
  name: string;
  cadenceMs: number;
  initialDelayMs?: number;
  advisoryLockId: number;
  writableStates: readonly string[];
  deadLetterPolicy: JobDeadLetterPolicy;
  disableEnvVar?: string;
  /** Optional DB handle for `public.scheduler_runs` persistence & boot gating. */
  db?: { execute: (query: any) => Promise<any> };
  /** Skip the initial post-boot run if `public.scheduler_runs` shows we are on schedule. */
  gateInitialRunOnSchedule?: boolean;
  /** Override lock runner in unit tests; defaults to `withAdvisoryLock`. */
  lockRunner?: <T>(lockId: number, fn: () => Promise<T>) => Promise<T | null>;
  /** Set to false to register externally-driven schedulers for observability + lock wrapping. */
  autoStartLoop?: boolean;
  run: () => Promise<void>;
}

export interface RegisteredJobHandle extends NonOverlappingSchedulerHandle {
  readonly name: string;
  readonly advisoryLockId: number;
  readonly disabled: boolean;
  runOnceLocked(): Promise<"completed" | "skipped_lock_held" | "disabled">;
}

export interface RegisteredJobStatusSnapshot {
  name: string;
  cadenceMs: number;
  initialDelayMs: number;
  advisoryLockId: number;
  writableStates: string[];
  deadLetterPolicy: JobDeadLetterPolicy;
  disabled: boolean;
  disableReason: string | null;
  inFlight: boolean;
  lockHeldInProcess: boolean;
  lastOutcome: RegisteredJobOutcome;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  persistedLastCompletedAt: string | null;
  lastSkippedLockAt: string | null;
  lastError: string | null;
  runCount: number;
  skippedLockHeldCount: number;
  errorCount: number;
}

interface RegisteredJobRecord {
  spec: RegisteredJobSpec & { initialDelayMs: number };
  disabled: boolean;
  disableReason: string | null;
  inFlight: boolean;
  firstTickPending: boolean;
  lastOutcome: RegisteredJobOutcome;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastSkippedLockAt: Date | null;
  lastError: string | null;
  runCount: number;
  skippedLockHeldCount: number;
  errorCount: number;
  handle: NonOverlappingSchedulerHandle | null;
}

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

const registryByName = new Map<string, RegisteredJobRecord>();
const lockOwnerByLockId = new Map<number, string>();

function validateJobSpec(spec: RegisteredJobSpec): void {
  const name = spec.name?.trim();
  if (!name) {
    throw new Error("registerScheduledJob: name must be a non-blank string");
  }
  if (!Number.isSafeInteger(spec.cadenceMs) || spec.cadenceMs <= 0) {
    throw new Error(`registerScheduledJob(${name}): cadenceMs must be a positive integer`);
  }
  const initialDelayMs = spec.initialDelayMs ?? 0;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error(`registerScheduledJob(${name}): initialDelayMs must be a non-negative integer`);
  }
  if (
    !Number.isInteger(spec.advisoryLockId) ||
    spec.advisoryLockId === 0 ||
    spec.advisoryLockId < INT4_MIN ||
    spec.advisoryLockId > INT4_MAX
  ) {
    throw new Error(
      `registerScheduledJob(${name}): advisoryLockId must be a non-zero 32-bit signed integer`,
    );
  }
  if (!Array.isArray(spec.writableStates)) {
    throw new Error(`registerScheduledJob(${name}): writableStates must be an array`);
  }

  const existingByName = registryByName.get(name);
  if (existingByName) {
    existingByName.handle?.stop();
    lockOwnerByLockId.delete(existingByName.spec.advisoryLockId);
    registryByName.delete(name);
  }

  const conflictingOwner = lockOwnerByLockId.get(spec.advisoryLockId);
  if (conflictingOwner && conflictingOwner !== name) {
    throw new Error(
      `registerScheduledJob(${name}): advisoryLockId ${spec.advisoryLockId} is already registered to '${conflictingOwner}'`,
    );
  }
}

export function registerScheduledJob(spec: RegisteredJobSpec): RegisteredJobHandle {
  validateJobSpec(spec);
  const name = spec.name.trim();
  const initialDelayMs = spec.initialDelayMs ?? 0;
  const disabled = schedulerIsDisabled(spec.disableEnvVar);
  const disableReason = disabled
    ? getSchedulerDisableReason(spec.disableEnvVar) ?? "disabled"
    : null;
  const lockRunner = spec.lockRunner ?? withAdvisoryLock;

  const record: RegisteredJobRecord = {
    spec: { ...spec, name, initialDelayMs },
    disabled,
    disableReason,
    inFlight: false,
    firstTickPending: true,
    lastOutcome: "never_run",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSkippedLockAt: null,
    lastError: null,
    runCount: 0,
    skippedLockHeldCount: 0,
    errorCount: 0,
    handle: null,
  };

  registryByName.set(name, record);
  lockOwnerByLockId.set(spec.advisoryLockId, name);

  const runOnceLocked = async (): Promise<"completed" | "skipped_lock_held" | "disabled"> => {
    if (record.disabled) {
      return "disabled";
    }
    const isInitialTick = record.firstTickPending;
    record.firstTickPending = false;

    if (isInitialTick && spec.gateInitialRunOnSchedule && spec.db) {
      const behind = await isBehindSchedule(spec.db, name, spec.cadenceMs);
      if (!behind) {
        return "completed";
      }
    }

    let executedInsideLock = false;
    const jobCorrelationId = `job:${name}:${Date.now()}`;
    await runWithContext({ correlationId: jobCorrelationId }, async () => {
      await lockRunner(spec.advisoryLockId, async () => {
        executedInsideLock = true;
        record.inFlight = true;
        const startedAt = new Date();
        record.lastStartedAt = startedAt;
        try {
          await observeRuntimeWork(name, spec.run);
          const completedAt = new Date();
          record.lastCompletedAt = completedAt;
          record.lastOutcome = "succeeded";
          record.lastError = null;
          record.runCount += 1;
          logger.debug("job.completed", {
            job_name: name,
            advisory_lock_id: spec.advisoryLockId,
            duration_ms: completedAt.getTime() - startedAt.getTime(),
          });
          if (spec.db) {
            await recordRunCompleted(spec.db, name, completedAt).catch((err: any) => {
              logger.warn("job.persist_completion_failed", {
                job_name: name,
                advisory_lock_id: spec.advisoryLockId,
                error: err instanceof Error ? err : String(err),
              });
            });
          }
        } catch (err: any) {
          record.errorCount += 1;
          record.lastOutcome = "failed";
          record.lastError = err instanceof Error ? err.message : String(err);
          logger.error("job.failed", {
            job_name: name,
            advisory_lock_id: spec.advisoryLockId,
            error: err instanceof Error ? err : String(err),
          });
          throw err;
        } finally {
          record.inFlight = false;
        }
      });
    });

    if (!executedInsideLock) {
      record.lastSkippedLockAt = new Date();
      record.lastOutcome = "skipped_lock_held";
      record.skippedLockHeldCount += 1;
      return "skipped_lock_held";
    }
    return "completed";
  };

  if (!disabled && spec.autoStartLoop !== false) {
    record.handle = startNonOverlappingScheduler({
      taskName: name,
      initialDelayMs,
      intervalMs: spec.cadenceMs,
      run: async () => {
        await runOnceLocked();
      },
    });
  }

  return {
    name,
    advisoryLockId: spec.advisoryLockId,
    disabled,
    runOnceLocked,
    stop(): void {
      record.handle?.stop();
      record.handle = null;
    },
  };
}

export async function getRegisteredJobsStatusSnapshot(
  db?: { execute: (query: any) => Promise<any> },
): Promise<RegisteredJobStatusSnapshot[]> {
  let persistedRuns: Record<string, string> = {};
  if (db) {
    try {
      persistedRuns = await listRecordedSchedulerRuns(db);
    } catch {
      persistedRuns = {};
    }
  }
  const activeLockIds = new Set(getSchedulerLockPoolSnapshot()?.activeLockIds ?? []);

  return [...registryByName.values()]
    .sort((a, b) => a.spec.name.localeCompare(b.spec.name))
    .map((rec) => {
      const inMemoryCompleted = rec.lastCompletedAt?.toISOString() ?? null;
      const persistedCompleted = persistedRuns[rec.spec.name] ?? null;
      const lastCompletedAt =
        inMemoryCompleted && persistedCompleted
          ? inMemoryCompleted > persistedCompleted
            ? inMemoryCompleted
            : persistedCompleted
          : inMemoryCompleted ?? persistedCompleted;

      return {
        name: rec.spec.name,
        cadenceMs: rec.spec.cadenceMs,
        initialDelayMs: rec.spec.initialDelayMs,
        advisoryLockId: rec.spec.advisoryLockId,
        writableStates: [...rec.spec.writableStates],
        deadLetterPolicy: rec.spec.deadLetterPolicy,
        disabled: rec.disabled,
        disableReason: rec.disableReason,
        inFlight: rec.inFlight,
        lockHeldInProcess: rec.inFlight || activeLockIds.has(rec.spec.advisoryLockId),
        lastOutcome: rec.lastOutcome,
        lastStartedAt: rec.lastStartedAt?.toISOString() ?? null,
        lastCompletedAt,
        persistedLastCompletedAt: persistedCompleted,
        lastSkippedLockAt: rec.lastSkippedLockAt?.toISOString() ?? null,
        lastError: rec.lastError,
        runCount: rec.runCount,
        skippedLockHeldCount: rec.skippedLockHeldCount,
        errorCount: rec.errorCount,
      };
    });
}

export function resetJobRegistryForTest(): void {
  for (const rec of registryByName.values()) {
    rec.handle?.stop();
  }
  registryByName.clear();
  lockOwnerByLockId.clear();
}
