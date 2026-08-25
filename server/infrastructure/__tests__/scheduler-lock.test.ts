import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const {
  createAdvisoryLockRunner,
  DEFAULT_SCHEDULER_LOCK_POOL_MAX,
  resolveSchedulerLockPoolMax,
} = await import("../scheduler-lock");

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

  it("runs the job while tracking, holding, and releasing an acquired advisory lock", async () => {
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
    const activeLocks = new Set<number>();

    const runner = createAdvisoryLockRunner({ connect }, logger, activeLocks);
    const result = await runner(123, async () => {
      expect([...activeLocks]).toEqual([123]);
      return "processed";
    });

    expect(result).toBe("processed");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, "SELECT pg_try_advisory_lock($1) as acquired", [123]);
    expect(query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1)", [123]);
    expect(activeLocks.size).toBe(0);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("skips the job without tracking or unlocking when the advisory lock is already held", async () => {
    query = vi.fn(async (): Promise<QueryResult> => ({ rows: [{ acquired: false }] }));
    connect = vi.fn(async () => ({ query, release }));
    const job = vi.fn(async () => "processed");
    const activeLocks = new Set<number>();

    const runner = createAdvisoryLockRunner({ connect }, logger, activeLocks);
    const result = await runner(123, job);

    expect(result).toBeNull();
    expect(job).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(activeLocks.size).toBe(0);
    expect(release).toHaveBeenCalledWith(undefined);
    expect(logger.log).toHaveBeenCalledWith("[AdvisoryLock] Lock 123 is already held by another worker. Skipping execution.");
  });

  it("releases the advisory lock, tracking evidence, and client when the job fails", async () => {
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
    const activeLocks = new Set<number>();

    const runner = createAdvisoryLockRunner({ connect }, logger, activeLocks);
    await expect(runner(456, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1)", [456]);
    expect(activeLocks.size).toBe(0);
    expect(release).toHaveBeenCalledWith(undefined);
    expect(logger.error).toHaveBeenCalledWith("[AdvisoryLock] Error running locked function for 456:", "boom");
  });

  it("classifies a pool acquisition timeout with the attempted lock ID", async () => {
    const acquisitionError = new Error("timeout exceeded when trying to connect");
    connect = vi.fn(async () => Promise.reject(acquisitionError));
    const runner = createAdvisoryLockRunner({ connect }, logger);

    await expect(runner(736204, async () => "processed")).rejects.toBe(acquisitionError);

    expect(logger.error).toHaveBeenCalledWith(
      "[AdvisoryLock] Failed to acquire pooled connection for lock 736204:",
      "timeout exceeded when trying to connect",
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("destroys the pooled client when session-lock release fails", async () => {
    const unlockError = new Error("connection terminated during unlock");
    query = vi.fn(async (statement: string): Promise<QueryResult> => {
      if (statement.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        throw unlockError;
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    connect = vi.fn(async () => ({ query, release }));
    const activeLocks = new Set<number>();
    const runner = createAdvisoryLockRunner({ connect }, logger, activeLocks);

    await expect(runner(736207, async () => "processed")).resolves.toBe("processed");

    expect(activeLocks.size).toBe(0);
    expect(release).toHaveBeenCalledWith(unlockError);
    expect(logger.error).toHaveBeenCalledWith(
      "[AdvisoryLock] Failed to release lock 736207:",
      "connection terminated during unlock",
    );
  });
});

describe("resolveSchedulerLockPoolMax", () => {
  it("defaults to bounded capacity for concurrent scheduler lock domains", () => {
    expect(resolveSchedulerLockPoolMax({})).toBe(DEFAULT_SCHEDULER_LOCK_POOL_MAX);
    expect(DEFAULT_SCHEDULER_LOCK_POOL_MAX).toBe(8);
  });

  it("uses a positive safe integer override", () => {
    expect(resolveSchedulerLockPoolMax({ SCHEDULER_LOCK_POOL_MAX: "12" })).toBe(12);
  });

  it("rejects blank, zero, negative, fractional, unsafe, and nonnumeric overrides", () => {
    for (const configuredValue of ["", " ", "0", "-1", "1.5", "9007199254740992", "invalid"]) {
      expect(resolveSchedulerLockPoolMax({
        SCHEDULER_LOCK_POOL_MAX: configuredValue,
      })).toBe(DEFAULT_SCHEDULER_LOCK_POOL_MAX);
    }
  });
});
