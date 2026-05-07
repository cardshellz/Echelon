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
    expect(String(query.mock.calls[0]?.[0])).toContain("updated_at <= $2 - ($3::text)::interval");
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
