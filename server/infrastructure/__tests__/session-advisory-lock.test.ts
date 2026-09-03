import { describe, expect, it, vi } from "vitest";

import {
  createSessionAdvisoryLockRunner,
  DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS,
  resolveSessionAdvisoryLockTimeoutMs,
  SESSION_ADVISORY_LOCK_ACQUIRE_FAILED,
  SESSION_ADVISORY_LOCK_INVALID_KEY,
  SESSION_ADVISORY_LOCK_TIMEOUT,
  SessionAdvisoryLockError,
  type SessionAdvisoryLockKey,
} from "../session-advisory-lock";

const LOCK: SessionAdvisoryLockKey = { namespace: 918407, key: 16610, label: "test.push" };

interface FakeClient {
  id: number;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/**
 * In-process model of Postgres session advisory locks: one holder per
 * (namespace, key); a second session's pg_advisory_lock waits until the holder
 * unlocks. Enough to prove the runner actually serializes callers.
 */
function makeLockManager() {
  const holders = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  const keyOf = (ns: number, key: number) => `${ns}:${key}`;

  return {
    async acquire(clientId: number, ns: number, key: number): Promise<void> {
      const k = keyOf(ns, key);
      while (holders.has(k) && holders.get(k) !== clientId) {
        await new Promise<void>((resolve) => {
          waiters.set(k, [...(waiters.get(k) ?? []), resolve]);
        });
      }
      holders.set(k, clientId);
    },
    release(clientId: number, ns: number, key: number): boolean {
      const k = keyOf(ns, key);
      if (holders.get(k) !== clientId) return false;
      holders.delete(k);
      const next = waiters.get(k)?.shift();
      next?.();
      return true;
    },
    holders,
  };
}

function makePool(options: {
  lockManager?: ReturnType<typeof makeLockManager>;
  onQuery?: (client: FakeClient, statement: string, params?: unknown[]) => Promise<unknown> | unknown;
} = {}) {
  const clients: FakeClient[] = [];
  const lockManager = options.lockManager ?? makeLockManager();
  const connect = vi.fn(async () => {
    const client: FakeClient = {
      id: clients.length + 1,
      release: vi.fn(),
      query: vi.fn(async (statement: string, params?: unknown[]) => {
        const custom = options.onQuery ? await options.onQuery(client, statement, params) : undefined;
        if (custom !== undefined) return custom;
        if (statement.includes("pg_advisory_lock(")) {
          await lockManager.acquire(client.id, Number(params?.[0]), Number(params?.[1]));
          return { rows: [{ pg_advisory_lock: null }] };
        }
        if (statement.includes("pg_advisory_unlock(")) {
          const unlocked = lockManager.release(client.id, Number(params?.[0]), Number(params?.[1]));
          return { rows: [{ unlocked }] };
        }
        return { rows: [] };
      }),
    };
    clients.push(client);
    return client;
  });
  return { connect, clients, lockManager };
}

function statementsOf(client: FakeClient): string[] {
  return client.query.mock.calls.map((call: any[]) => String(call[0]));
}

describe("createSessionAdvisoryLockRunner", () => {
  it("acquires, runs, and unlocks on ONE pinned client, then returns it to the pool", async () => {
    const pool = makePool();
    const logger = { error: vi.fn() };
    const runner = createSessionAdvisoryLockRunner(pool, { lockTimeoutMs: 5_000, logger });

    const result = await runner(LOCK, async () => "pushed");

    expect(result).toBe("pushed");
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const [client] = pool.clients;
    expect(statementsOf(client)).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '5000ms'",
      "SELECT pg_advisory_lock($1, $2)",
      "COMMIT",
      "SELECT pg_advisory_unlock($1, $2) AS unlocked",
    ]);
    expect(client.query).toHaveBeenNthCalledWith(3, "SELECT pg_advisory_lock($1, $2)", [918407, 16610]);
    expect(client.query).toHaveBeenNthCalledWith(5, "SELECT pg_advisory_unlock($1, $2) AS unlocked", [918407, 16610]);
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(pool.lockManager.holders.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("holds the lock for the whole critical section: a second caller on the same key waits", async () => {
    const pool = makePool();
    const runner = createSessionAdvisoryLockRunner(pool, { lockTimeoutMs: 5_000 });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runner(LOCK, async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      return 1;
    });
    // Let the first caller reach its critical section before starting the second.
    await new Promise((resolve) => setImmediate(resolve));
    const second = runner(LOCK, async () => {
      order.push("second:start");
      order.push("second:end");
      return 2;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    // Two callers → two pinned clients; the pool never mixes them.
    expect(pool.clients).toHaveLength(2);
  });

  it("does not block callers on a different key", async () => {
    const pool = makePool();
    const runner = createSessionAdvisoryLockRunner(pool, { lockTimeoutMs: 5_000 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runner(LOCK, async () => { await firstGate; return "a"; });
    await new Promise((resolve) => setImmediate(resolve));
    const other = await runner({ ...LOCK, key: 16611 }, async () => "b");

    expect(other).toBe("b");
    releaseFirst();
    await expect(first).resolves.toBe("a");
  });

  it("unlocks and rethrows when the critical section throws", async () => {
    const pool = makePool();
    const runner = createSessionAdvisoryLockRunner(pool);
    const failure = new Error("ShipStation exploded");

    await expect(runner(LOCK, async () => { throw failure; })).rejects.toBe(failure);

    const [client] = pool.clients;
    expect(statementsOf(client).at(-1)).toBe("SELECT pg_advisory_unlock($1, $2) AS unlocked");
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(pool.lockManager.holders.size).toBe(0);
  });

  it("classifies a lock_timeout expiry as a transient SESSION_ADVISORY_LOCK_TIMEOUT and destroys the client", async () => {
    const pool = makePool({
      onQuery: (_client, statement) => {
        if (statement.includes("pg_advisory_lock(")) {
          throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        }
        return undefined;
      },
    });
    const runner = createSessionAdvisoryLockRunner(pool, { lockTimeoutMs: 2_000 });
    const fn = vi.fn(async () => "never");

    const error = await runner(LOCK, fn).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionAdvisoryLockError);
    expect((error as SessionAdvisoryLockError).context).toMatchObject({
      code: SESSION_ADVISORY_LOCK_TIMEOUT,
      classification: "transient",
      label: "test.push",
      namespace: 918407,
      key: 16610,
      lockTimeoutMs: 2_000,
    });
    expect(fn).not.toHaveBeenCalled();
    const [client] = pool.clients;
    expect(statementsOf(client)).not.toContain("SELECT pg_advisory_unlock($1, $2) AS unlocked");
    // An aborted acquisition leaves the session in an unknown state → destroy it.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("classifies any other acquisition failure as transient SESSION_ADVISORY_LOCK_ACQUIRE_FAILED", async () => {
    const pool = makePool({
      onQuery: (_client, statement) => {
        if (statement === "BEGIN") throw new Error("connection terminated");
        return undefined;
      },
    });
    const runner = createSessionAdvisoryLockRunner(pool);

    const error = await runner(LOCK, async () => "never").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionAdvisoryLockError);
    expect((error as SessionAdvisoryLockError).context.code).toBe(SESSION_ADVISORY_LOCK_ACQUIRE_FAILED);
    expect((error as SessionAdvisoryLockError).classification).toBe("transient");
    expect(pool.clients[0].release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("destroys the client when the unlock fails, but preserves the section's result", async () => {
    const pool = makePool({
      onQuery: (_client, statement) => {
        if (statement.includes("pg_advisory_unlock(")) throw new Error("socket hang up");
        return undefined;
      },
    });
    const logger = { error: vi.fn() };
    const runner = createSessionAdvisoryLockRunner(pool, { logger });

    await expect(runner(LOCK, async () => "done")).resolves.toBe("done");

    const [client] = pool.clients;
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0][0])).toMatchObject({
      action: "session_advisory_lock_unlock",
      outcome: "failed",
      label: "test.push",
    });
  });

  it("destroys the client when Postgres reports the lock was not held by this session", async () => {
    const pool = makePool({
      onQuery: (_client, statement) => {
        if (statement.includes("pg_advisory_unlock(")) return { rows: [{ unlocked: false }] };
        return undefined;
      },
    });
    const logger = { error: vi.fn() };
    const runner = createSessionAdvisoryLockRunner(pool, { logger });

    await expect(runner(LOCK, async () => "done")).resolves.toBe("done");

    expect(pool.clients[0].release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(JSON.parse(logger.error.mock.calls[0][0])).toMatchObject({
      action: "session_advisory_lock_unlock",
      outcome: "not_held",
    });
  });

  it("rejects keys outside int4 and empty labels before touching the pool", async () => {
    const pool = makePool();
    const runner = createSessionAdvisoryLockRunner(pool);

    for (const bad of [
      { ...LOCK, key: 2_147_483_648 },
      { ...LOCK, key: 1.5 },
      { ...LOCK, key: Number.NaN },
      { ...LOCK, namespace: -2_147_483_649 },
      { ...LOCK, label: " " },
    ]) {
      const error = await runner(bad, async () => "never").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SessionAdvisoryLockError);
      expect((error as SessionAdvisoryLockError).context.code).toBe(SESSION_ADVISORY_LOCK_INVALID_KEY);
      expect((error as SessionAdvisoryLockError).classification).toBe("permanent");
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range lock timeout at construction", () => {
    expect(() => createSessionAdvisoryLockRunner(makePool(), { lockTimeoutMs: 10 })).toThrow(/lockTimeoutMs/);
    expect(() => createSessionAdvisoryLockRunner(makePool(), { lockTimeoutMs: 1.5 })).toThrow(/lockTimeoutMs/);
  });

  it("propagates a pool connect failure without running the section", async () => {
    const connect = vi.fn(async () => { throw new Error("timeout exceeded when trying to connect"); });
    const runner = createSessionAdvisoryLockRunner({ connect });
    const fn = vi.fn(async () => "never");

    await expect(runner(LOCK, fn)).rejects.toThrow(/timeout exceeded/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("resolveSessionAdvisoryLockTimeoutMs", () => {
  it("uses the default when the env var is missing, non-numeric, or out of bounds", () => {
    expect(resolveSessionAdvisoryLockTimeoutMs({})).toBe(DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS);
    expect(resolveSessionAdvisoryLockTimeoutMs({ SESSION_ADVISORY_LOCK_TIMEOUT_MS: "soon" })).toBe(DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS);
    expect(resolveSessionAdvisoryLockTimeoutMs({ SESSION_ADVISORY_LOCK_TIMEOUT_MS: "5" })).toBe(DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS);
    expect(resolveSessionAdvisoryLockTimeoutMs({ SESSION_ADVISORY_LOCK_TIMEOUT_MS: "999999999" })).toBe(DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS);
  });

  it("accepts an in-range integer override", () => {
    expect(resolveSessionAdvisoryLockTimeoutMs({ SESSION_ADVISORY_LOCK_TIMEOUT_MS: "45000" })).toBe(45_000);
  });
});
