import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

// The sweep's session lock, as the scheduled sweep holding it would answer (review MC5): busy, or held for the call.
const sweepLock = vi.hoisted(() => ({ busy: false, ids: [] as number[] }));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({
  withAdvisoryLock: async <T>(lockId: number, fn: () => Promise<T>): Promise<T | null> => {
    sweepLock.ids.push(lockId);
    return sweepLock.busy ? null : fn();
  },
}));

import {
  PgDropshipListingPushJobQueueRepository,
  runAdminListingPushSweep,
  runDropshipListingPushSweep,
  type DropshipListingPushJobQueueRepository,
  type DropshipListingPushRunSweepSteps,
} from "../../infrastructure/dropship-listing-push-job-runner";

/** The publish run steps, recording their order against job processing. */
function runSteps(order: string[], failures: { reconcile?: Error; expand?: Error } = {}): DropshipListingPushRunSweepSteps {
  return {
    reconcileAndFinish: async () => {
      order.push("reconcile");
      if (failures.reconcile) throw failures.reconcile;
      return { changed: 0, finished: 0 };
    },
    expandRuns: async () => {
      order.push("expand");
      if (failures.expand) throw failures.expand;
      return { attempted: 0, queued: 0 };
    },
  };
}

const now = new Date("2026-05-07T17:15:00.000Z");

describe("runDropshipListingPushSweep", () => {
  it("lists stale processing jobs and uses stable per-job idempotency keys", async () => {
    const repository = new FakeListingPushJobQueueRepository([30, 31]);
    const processedInputs: Array<{
      jobId: number;
      workerId: string;
      idempotencyKey: string;
      staleProcessingMinutes: number;
    }> = [];

    const result = await runDropshipListingPushSweep({
      repository,
      processJob: async (input) => {
        processedInputs.push(input);
      },
      runs: runSteps([]),
      batchSize: 25,
      staleProcessingMinutes: 45,
      now,
      workerId: "worker-1",
    });

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(repository.lastInput).toEqual({
      limit: 25,
      now,
      staleAfterMinutes: 45,
    });
    expect(processedInputs).toEqual([
      {
        jobId: 30,
        workerId: "worker-1",
        idempotencyKey: "dropship-listing-push:job:30",
        staleProcessingMinutes: 45,
      },
      {
        jobId: 31,
        workerId: "worker-1",
        idempotencyKey: "dropship-listing-push:job:31",
        staleProcessingMinutes: 45,
      },
    ]);
  });
});

describe("runDropshipListingPushSweep recovery", () => {
  const emptyRecovery = { listingsRestored: 0, listingsNeedingReview: 0, jobsRequeued: 0, itemsRequeued: 0, rowFailures: 0, stepFailures: 0 };

  it("runs the recovery before it lists jobs, so a job requeued by it is processed in the same sweep", async () => {
    const order: string[] = [];
    const repository = new FakeListingPushJobQueueRepository([30]);
    const listClaimableJobIds = repository.listClaimableJobIds.bind(repository);
    repository.listClaimableJobIds = async (input) => { order.push("list"); return listClaimableJobIds(input); };

    const result = await runDropshipListingPushSweep({
      repository,
      processJob: async () => { order.push("process"); },
      recovery: { run: async (input) => { order.push(`recover:${input.workerId}`); return { ...emptyRecovery, jobsRequeued: 1, itemsRequeued: 1 }; } },
      runs: runSteps(order),
      now,
      workerId: "worker-1",
    });

    // One sweep (rebase of PR A onto PR 1b): recovery first, so the publish run pre-filter reads a restored
    // listing's live status; then the run steps (reconcile, expand), so a chunk is recorded before any of its items
    // can start; then the claims; then a reconcile after each job (verify V1).
    expect(order).toEqual(["recover:worker-1", "reconcile", "expand", "list", "process", "reconcile"]);
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  function recordingLogger() {
    const events: Array<{ level: string; code: string; context?: Record<string, unknown> }> = [];
    return {
      events,
      logger: {
        info: (event: { code: string; message: string; context?: Record<string, unknown> }) => events.push({ level: "info", ...event }),
        warn: (event: { code: string; message: string; context?: Record<string, unknown> }) => events.push({ level: "warn", ...event }),
        error: (event: { code: string; message: string; context?: Record<string, unknown> }) => events.push({ level: "error", ...event }),
      },
    };
  }

  it("still processes jobs when the recovery throws, and logs it through the structured logger with an error code", async () => {
    const processed: number[] = [];
    const runOrder: string[] = [];
    const { events, logger } = recordingLogger();
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30, 31]),
      processJob: async (input) => { processed.push(input.jobId); },
      recovery: { run: async () => { throw new Error("recovery exploded"); } },
      runs: runSteps(runOrder),
      logger,
      now,
      workerId: "worker-1",
    });
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(processed).toEqual([30, 31]);
    // The publish run steps still run after a failed recovery.
    expect(runOrder).toEqual(["reconcile", "expand", "reconcile", "reconcile"]);
    expect(events).toEqual([expect.objectContaining({
      level: "error", code: "DROPSHIP_LISTING_PUSH_RECOVERY_FAILED",
      context: expect.objectContaining({ action: "listing_push_recovery", outcome: "failed", classification: "transient",
        error: "recovery exploded", error_code: "DROPSHIP_LISTING_PUSH_RECOVERY_FAILED", workerId: "worker-1" }),
    })]);
  });

  it("logs the thrown error's own code as error_code", async () => {
    const { events, logger } = recordingLogger();
    const thrown = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      recovery: { run: async () => { throw thrown; } },
      runs: runSteps([]),
      logger,
      now,
      workerId: "worker-1",
    });
    expect(events.map((event) => [event.level, event.code, event.context?.error_code])).toEqual([
      ["error", "DROPSHIP_LISTING_PUSH_RECOVERY_FAILED", "ECONNRESET"],
    ]);
  });

  it("logs a recovery pass that changed something at INFO, with its counts, and stays quiet when nothing changed", async () => {
    const { events, logger } = recordingLogger();
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      recovery: { run: async () => ({ ...emptyRecovery, listingsRestored: 2 }) },
      runs: runSteps([]),
      logger,
      now,
      workerId: "worker-1",
    });
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      recovery: { run: async () => emptyRecovery },
      runs: runSteps([]),
      logger,
      now,
      workerId: "worker-1",
    });
    expect(events).toEqual([expect.objectContaining({
      level: "info", code: "DROPSHIP_LISTING_PUSH_RECOVERY_COMPLETED",
      context: expect.objectContaining({ action: "listing_push_recovery", outcome: "completed", listingsRestored: 2, workerId: "worker-1" }),
    })]);
  });

  it("does not run any recovery when none is passed (manual ops sweep)", async () => {
    const order: string[] = [];
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      runs: runSteps(order),
      now,
      workerId: "worker-1",
    });
    expect(result).toEqual({ processed: 0, failed: 0 });
    // The run steps still run (no job, so no reconcile after one).
    expect(order).toEqual(["reconcile", "expand"]);
  });
});

describe("runDropshipListingPushSweep and publish runs (step 1 plan S2-5, §4.3-§4.4)", () => {
  it("reconciles, then expands, then processes jobs, all in the one sweep, and finishes runs again after each job (verify V1)", async () => {
    const order: string[] = [];
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30, 31]),
      processJob: async (input) => { order.push(`job:${input.jobId}`); },
      runs: runSteps(order),
      now,
      workerId: "worker-1",
    });
    // A run whose chunk job just ended, or that was stopped while it ran, finishes before the next job, not at the
    // next sweep.
    expect(order).toEqual(["reconcile", "expand", "job:30", "reconcile", "job:31", "reconcile"]);
  });

  it("finishes runs after a job that failed too", async () => {
    const order: string[] = [];
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30]),
      processJob: async (input) => { order.push(`job:${input.jobId}`); throw new Error("worker crashed"); },
      runs: runSteps(order),
      now,
      workerId: "worker-1",
    });
    expect(order).toEqual(["reconcile", "expand", "job:30", "reconcile"]);
    expect(result).toEqual({ processed: 0, failed: 1 });
  });

  it("goes on to expansion and jobs when a run step fails; the next sweep retries it", async () => {
    const order: string[] = [];
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30]),
      processJob: async (input) => { order.push(`job:${input.jobId}`); },
      runs: runSteps(order, { reconcile: new Error("database unavailable"), expand: new Error("database unavailable") }),
      now,
      workerId: "worker-1",
    });
    expect(order).toEqual(["reconcile", "expand", "job:30", "reconcile"]);
    expect(result).toEqual({ processed: 1, failed: 0 });
  });
});

describe("the run steps outside the scheduled sweep (review MC5, CT2)", () => {
  it("runs the publish run steps only under the sweep lock: busy skips them, and jobs are still processed", async () => {
    const order: string[] = [];
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30]),
      processJob: async (input) => { order.push(`job:${input.jobId}`); },
      runs: runSteps(order),
      // The scheduled sweep holds lock 736204: the admin's sweep may not expand or finish runs beside it.
      runStepsGuard: async () => false,
      now,
      workerId: "admin-1",
    });
    // Busy: no run step at all, before or after the job.
    expect(order).toEqual(["job:30"]);
    expect(result).toEqual({ processed: 1, failed: 0, runStepsSkipped: 1 });

    const locked: string[] = [];
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([31]),
      processJob: async (input) => { locked.push(`job:${input.jobId}`); },
      runs: runSteps(locked),
      runStepsGuard: async (steps) => { locked.push("lock"); await steps(); locked.push("unlock"); return true; },
      now,
      workerId: "admin-1",
    });
    expect(locked).toEqual(["lock", "reconcile", "expand", "unlock", "job:31", "lock", "reconcile", "unlock"]);
  });

  it("the admin \"run sweep now\" takes the scheduled sweep's lock (736204) for the run steps, and skips them while it is held", async () => {
    sweepLock.busy = true;
    sweepLock.ids = [];
    const order: string[] = [];
    const busy = await runAdminListingPushSweep({ workerId: "admin-1", batchSize: 5, now,
      repository: new FakeListingPushJobQueueRepository([30]), runs: runSteps(order),
      processJob: async (input) => { order.push(`job:${input.jobId}`); } });
    expect(sweepLock.ids).toEqual([736204]);
    expect(order).toEqual(["job:30"]);
    expect(busy).toMatchObject({ processed: 1, runStepsSkipped: 1 });
    sweepLock.busy = false;
    const free: string[] = [];
    await runAdminListingPushSweep({ workerId: "admin-1", now,
      repository: new FakeListingPushJobQueueRepository([31]), runs: runSteps(free),
      processJob: async (input) => { free.push(`job:${input.jobId}`); } });
    expect(free).toEqual(["reconcile", "expand", "job:31", "reconcile"]);
    expect(sweepLock.ids).toEqual([736204, 736204, 736204]);
    // The staff route's runner is this one.
    const { createDropshipWorkerSweepRunners } = await import("../../infrastructure/dropship-worker-ops.factory");
    expect(createDropshipWorkerSweepRunners().listing_push.run.toString()).toContain("runAdminListingPushSweep");
  });
});

describe("PgDropshipListingPushJobQueueRepository", () => {
  it("never claims a run's chunk job before its chunk is recorded (review MC10)", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new PgDropshipListingPushJobQueueRepository({ query } as unknown as Pool);
    await repository.listClaimableJobIds({ limit: 10, now, staleAfterMinutes: 30 });
    expect(String(query.mock.calls[0]?.[0]).replace(/\s+/g, " ")).toContain(
      "AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets t WHERE t.run_id = j.run_id "
      + "AND t.chunk_index = j.run_chunk_index AND t.outcome = 'pending')");
  });

  it("selects queued and stale processing jobs", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 30 }] }));
    const repository = new PgDropshipListingPushJobQueueRepository({ query } as unknown as Pool);

    const result = await repository.listClaimableJobIds({
      limit: 10,
      now,
      staleAfterMinutes: 30,
    });

    expect(result).toEqual([30]);
    // The job is aliased `j` since the chunk-recorded filter (review MC10); the conditions are the same.
    expect(String(query.mock.calls[0]?.[0])).toContain("j.status = 'queued'");
    // A paused job waits for its next attempt (§4.5).
    expect(String(query.mock.calls[0]?.[0]).replace(/\s+/g, " ")).toContain(
      "j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= $2::timestamptz)");
    expect(String(query.mock.calls[0]?.[0])).toContain("j.status = 'processing'");
    expect(String(query.mock.calls[0]?.[0])).toContain("j.updated_at <= $2::timestamptz - ($3::text)::interval");
    expect(query.mock.calls[0]?.[1]).toEqual([10, now, "30 minutes"]);
  });
});

class FakeListingPushJobQueueRepository implements DropshipListingPushJobQueueRepository {
  lastInput: Parameters<DropshipListingPushJobQueueRepository["listClaimableJobIds"]>[0] | null = null;

  constructor(private readonly jobIds: number[]) {}

  async listClaimableJobIds(
    input: Parameters<DropshipListingPushJobQueueRepository["listClaimableJobIds"]>[0],
  ): Promise<number[]> {
    this.lastInput = input;
    return this.jobIds;
  }
}
