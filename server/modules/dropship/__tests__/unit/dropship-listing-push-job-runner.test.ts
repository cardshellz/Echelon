import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import {
  PgDropshipListingPushJobQueueRepository,
  runDropshipListingPushSweep,
  type DropshipListingPushJobQueueRepository,
} from "../../infrastructure/dropship-listing-push-job-runner";

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
      now,
      workerId: "worker-1",
    });

    expect(order).toEqual(["recover:worker-1", "list", "process"]);
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
    const { events, logger } = recordingLogger();
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([30, 31]),
      processJob: async (input) => { processed.push(input.jobId); },
      recovery: { run: async () => { throw new Error("recovery exploded"); } },
      logger,
      now,
      workerId: "worker-1",
    });
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(processed).toEqual([30, 31]);
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
      logger,
      now,
      workerId: "worker-1",
    });
    await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      recovery: { run: async () => emptyRecovery },
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
    const result = await runDropshipListingPushSweep({
      repository: new FakeListingPushJobQueueRepository([]),
      processJob: async () => undefined,
      now,
      workerId: "worker-1",
    });
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});

describe("PgDropshipListingPushJobQueueRepository", () => {
  it("selects queued and stale processing jobs", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 30 }] }));
    const repository = new PgDropshipListingPushJobQueueRepository({ query } as unknown as Pool);

    const result = await repository.listClaimableJobIds({
      limit: 10,
      now,
      staleAfterMinutes: 30,
    });

    expect(result).toEqual([30]);
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'queued'");
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'processing'");
    expect(String(query.mock.calls[0]?.[0])).toContain("updated_at <= $2::timestamptz - ($3::text)::interval");
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
