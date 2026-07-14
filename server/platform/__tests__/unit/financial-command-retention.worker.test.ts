import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { purgeExpiredFinancialCommandResults } = vi.hoisted(() => ({
  purgeExpiredFinancialCommandResults: vi.fn(),
}));

vi.mock("../../commands/financial-command-operations.service", () => ({
  purgeExpiredFinancialCommandResults,
}));

import { runFinancialCommandRetentionTick } from "../../commands/financial-command-retention.worker";

describe("financial command retention worker", () => {
  beforeEach(() => {
    purgeExpiredFinancialCommandResults.mockReset();
  });

  it("runs bounded batches and stops after a partial batch", async () => {
    purgeExpiredFinancialCommandResults
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(17);

    await expect(runFinancialCommandRetentionTick({
      dbPool: {} as Pool,
      batchSize: 500,
      maxBatches: 5,
    })).resolves.toEqual({ status: "success", deleted: 1_017 });
    expect(purgeExpiredFinancialCommandResults).toHaveBeenCalledTimes(3);
  });

  it("does not overlap cleanup ticks", async () => {
    let release!: (value: number) => void;
    purgeExpiredFinancialCommandResults.mockImplementationOnce(() => new Promise<number>((resolve) => {
      release = resolve;
    }));

    const first = runFinancialCommandRetentionTick({
      dbPool: {} as Pool,
      batchSize: 10,
      maxBatches: 1,
    });
    await Promise.resolve();
    await expect(runFinancialCommandRetentionTick({
      dbPool: {} as Pool,
      batchSize: 10,
      maxBatches: 1,
    })).resolves.toEqual({ status: "skipped", deleted: 0 });
    release(0);
    await expect(first).resolves.toEqual({ status: "success", deleted: 0 });
  });

  it("reports cleanup errors without throwing the scheduler loop", async () => {
    purgeExpiredFinancialCommandResults.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(runFinancialCommandRetentionTick({
      dbPool: {} as Pool,
      batchSize: 100,
      maxBatches: 1,
    })).resolves.toEqual({ status: "error", deleted: 0 });
  });
});
