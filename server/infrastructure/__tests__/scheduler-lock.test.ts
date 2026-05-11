import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const { createAdvisoryLockRunner } = await import("../scheduler-lock");

interface QueryResult {
  rows: Array<Record<string, unknown>>;
}

describe("createAdvisoryLockRunner", () => {
  let query: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;
  let logger: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    release = vi.fn();
    logger = { log: vi.fn(), error: vi.fn() };
  });

  it("runs the job while holding and releasing an acquired advisory lock", async () => {
    query = vi.fn(async (statement: string): Promise<QueryResult> => {
      if (statement.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    connect = vi.fn(async () => ({ query, release }));

    const runner = createAdvisoryLockRunner({ connect }, logger);
    const result = await runner(123, async () => "processed");

    expect(result).toBe("processed");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, "SELECT pg_try_advisory_lock($1) as acquired", [123]);
    expect(query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1)", [123]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips the job without unlocking when the advisory lock is already held", async () => {
    query = vi.fn(async (): Promise<QueryResult> => ({ rows: [{ acquired: false }] }));
    connect = vi.fn(async () => ({ query, release }));
    const job = vi.fn(async () => "processed");

    const runner = createAdvisoryLockRunner({ connect }, logger);
    const result = await runner(123, job);

    expect(result).toBeNull();
    expect(job).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith("[AdvisoryLock] Lock 123 is already held by another worker. Skipping execution.");
  });

  it("releases the advisory lock and client when the job fails", async () => {
    query = vi.fn(async (statement: string): Promise<QueryResult> => {
      if (statement.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    connect = vi.fn(async () => ({ query, release }));

    const runner = createAdvisoryLockRunner({ connect }, logger);
    await expect(runner(456, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1)", [456]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("[AdvisoryLock] Error running locked function for 456:", "boom");
  });
});
