import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PROCESS_HEARTBEAT_ALERT_AFTER_FAILURES,
  PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS,
  PROCESS_HEARTBEAT_INTERVAL_MS,
  PROCESS_HEARTBEAT_MAINTENANCE_INTERVAL_MS,
  PROCESS_HEARTBEAT_RETENTION_MS,
  PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS,
  dropshipProcessKey,
  startDropshipProcessHeartbeat,
  startDropshipProcessHeartbeatFromEnv,
  type DropshipProcessHeartbeatStore,
  type DropshipProcessHeartbeatTimers,
} from "../../infrastructure/dropship-process-heartbeat";
import {
  catalogVersionAtLeastSettled,
  catalogVersionSettled,
  deleteStaleProcessHeartbeats,
  hasLiveOlderCatalogProcess,
  listOlderProcessesStillRunning,
  writeProcessHeartbeat,
} from "../../infrastructure/dropship-process-heartbeat.repository";

/**
 * The process heartbeat of step 1 plan S2-5 §4.9 item 1 (D37, CHK2, CHK10):
 * first beat awaited and bounded, interval beats, the hourly cleanup and the
 * older-process alert, no signal listener and no delete of its own row, and
 * the start order in server/index.ts. Timers and the store are injected; the
 * database clock is pinned by the SQL (PG cases in
 * dropship-release-readiness.integration.test.ts).
 */
const sideChannel = vi.hoisted(() => ({
  configs: [] as unknown[],
  listeners: [] as string[],
  queries: [] as string[],
}));
vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
  createSideChannelPool: (config: unknown) => {
    sideChannel.configs.push(config);
    return {
      on: (event: string) => { sideChannel.listeners.push(event); },
      query: async (sql: string) => { sideChannel.queries.push(sql); return { rows: [], rowCount: 1 }; },
    };
  },
}));

class FakeTimers implements DropshipProcessHeartbeatTimers {
  intervals: Array<{ id: number; callback: () => void; ms: number; cleared: boolean }> = [];
  timeouts: Array<{ id: number; callback: () => void; ms: number; cleared: boolean }> = [];
  private next = 1;
  setInterval(callback: () => void, ms: number) {
    const entry = { id: this.next++, callback, ms, cleared: false };
    this.intervals.push(entry);
    return entry.id;
  }
  clearInterval(handle: unknown) {
    const entry = this.intervals.find((item) => item.id === handle);
    if (entry) entry.cleared = true;
  }
  setTimeout(callback: () => void, ms: number) {
    const entry = { id: this.next++, callback, ms, cleared: false };
    this.timeouts.push(entry);
    return entry.id;
  }
  clearTimeout(handle: unknown) {
    const entry = this.timeouts.find((item) => item.id === handle);
    if (entry) entry.cleared = true;
  }
  interval(ms: number) {
    const entry = this.intervals.find((item) => item.ms === ms);
    if (!entry) throw new Error(`No interval of ${ms} ms`);
    return entry;
  }
}

function deferred<T = void>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => { resolvePromise = resolveFn; rejectPromise = rejectFn; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function harness(beat: DropshipProcessHeartbeatStore["beat"]) {
  const timers = new FakeTimers();
  const logs: Array<{ level: string; action: string; data: Record<string, unknown> }> = [];
  const log = (level: string) => (action: string, data: Record<string, unknown>) => { logs.push({ level, action, data }); };
  const store = {
    beat: vi.fn(beat),
    deleteStale: vi.fn(async () => 0),
    listOlderStillRunning: vi.fn(async () => [] as Awaited<ReturnType<DropshipProcessHeartbeatStore["listOlderStillRunning"]>>),
  };
  const start = () => startDropshipProcessHeartbeat({
    store, timers, processKey: "web.1:boot-a",
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
  });
  return { timers, logs, store, start };
}

const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));

describe("startDropshipProcessHeartbeat (S2-5 §4.9 item 1)", () => {
  it("resolves only after its first beat is written, with this process's key and catalog code version 3 (PR C)", async () => {
    const write = deferred();
    const { store, start, logs } = harness(() => write.promise);
    let started = false;
    const handle = start().then((value) => { started = true; return value; });

    await flush();
    expect(store.beat).toHaveBeenCalledWith({ processKey: "web.1:boot-a", catalogCodeVersion: 3 });
    expect(started).toBe(false);
    write.resolve();
    expect(await handle).toMatchObject({ firstBeat: "written", catalogCodeVersion: 3, processKey: "web.1:boot-a" });
    expect(logs).toEqual([expect.objectContaining({ level: "info", action: "dropship.process_heartbeat.started" })]);
  });

  it(`gives up waiting after ${PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS} ms with a WARN, and the server starts anyway`, async () => {
    const { timers, start, logs } = harness(() => new Promise(() => undefined));
    const handle = start();
    await flush();

    // The beat's own write timeout, then the first-write wait.
    expect(timers.timeouts.map((entry) => entry.ms)).toEqual([PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS, PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS]);
    timers.timeouts[1].callback();
    expect((await handle).firstBeat).toBe("timed_out");
    expect(logs).toEqual([expect.objectContaining({
      level: "warn", action: "dropship.process_heartbeat.first_write_timed_out",
      data: expect.objectContaining({ outcome: "continued", error_class: "transient" }),
    })]);
    // The beat loop still runs.
    expect(timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS).cleared).toBe(false);
  });

  it("clears the first-write timeout when the beat lands first", async () => {
    const { timers, start } = harness(async () => undefined);
    await start();
    expect(timers.timeouts).toHaveLength(2);
    expect(timers.timeouts.every((entry) => entry.cleared)).toBe(true);
  });

  it("continues after a failed first beat with one WARN, retries at the interval, and says when it recovered", async () => {
    let fail = true;
    const { timers, start, logs, store } = harness(async () => { if (fail) throw new Error("connection refused"); });
    const handle = await start();

    expect(handle.firstBeat).toBe("failed");
    expect(logs.map((entry) => [entry.level, entry.action])).toEqual([["warn", "dropship.process_heartbeat.write_failed"]]);
    expect(logs[0].data).toMatchObject({ error_code: "DROPSHIP_PROCESS_HEARTBEAT_WRITE_FAILED", error_message: "connection refused" });

    // Half the grace without a beat (two in a row): one ERROR, since a later release could take this live process for
    // gone (verify V5); later failures of the same streak are DEBUG, never another WARN.
    expect(PROCESS_HEARTBEAT_ALERT_AFTER_FAILURES).toBe(2);
    timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS).callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "error", action: "dropship.process_heartbeat.write_failing",
      data: expect.objectContaining({ failed_beats: 2, outcome: "row_ageing", grace_ms: 120_000 }) });
    timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS).callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "debug", action: "dropship.process_heartbeat.write_failed" });

    fail = false;
    timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS).callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "info", action: "dropship.process_heartbeat.recovered", data: expect.objectContaining({ failed_beats: 3 }) });
    expect(logs.filter((entry) => entry.level === "warn")).toHaveLength(1);
    expect(logs.filter((entry) => entry.level === "error")).toHaveLength(1);
    expect(store.beat).toHaveBeenCalledTimes(4);
  });

  it(`beats every ${PROCESS_HEARTBEAT_INTERVAL_MS} ms, one beat at a time`, async () => {
    const { timers, start, store } = harness(async () => undefined);
    await start();
    const tick = timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS);

    const slow = deferred();
    store.beat.mockImplementationOnce(() => slow.promise);
    tick.callback();
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(2);
    slow.resolve();
    await flush();
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(3);
  });

  it(`counts a beat that has not settled within ${PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS} ms as failed and frees the next beat (verify V5)`, async () => {
    const { timers, start, store, logs } = harness(async () => undefined);
    await start();
    const tick = timers.interval(PROCESS_HEARTBEAT_INTERVAL_MS);
    // A beat whose connection went half-open: it never settles by itself.
    const stuck = deferred();
    store.beat.mockImplementationOnce(() => stuck.promise);
    tick.callback();
    await flush();
    const writeTimeout = timers.timeouts.at(-1)!;
    expect(writeTimeout.ms).toBe(PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS);
    // Before the timeout, the next tick waits for the beat in flight (one at a time).
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(2);
    writeTimeout.callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "warn", action: "dropship.process_heartbeat.write_failed",
      data: expect.objectContaining({ error_code: "DROPSHIP_PROCESS_HEARTBEAT_WRITE_TIMED_OUT" }) });
    // The next tick writes again instead of waiting for the stuck one for ever.
    const next = deferred();
    store.beat.mockImplementationOnce(() => next.promise);
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(3);
    // The stuck write settling late frees nothing that is not its own: the beat in flight still holds its slot.
    stuck.resolve();
    await flush();
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(3);
    next.resolve();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "info", action: "dropship.process_heartbeat.recovered" });
    tick.callback();
    await flush();
    expect(store.beat).toHaveBeenCalledTimes(4);
  });

  it("writes beats on a one-connection pool of its own with bounded statements, and listens for its errors (verify V5)", async () => {
    sideChannel.configs.length = 0;
    sideChannel.listeners.length = 0;
    sideChannel.queries.length = 0;
    const handle = await startDropshipProcessHeartbeatFromEnv();
    try {
      expect(handle.firstBeat).toBe("written");
      expect(sideChannel.configs).toEqual([{ max: 1, statementTimeoutMs: 5_000, queryTimeoutMs: 8_000, connectionTimeoutMs: 5_000,
        idleTimeoutMs: 2 * PROCESS_HEARTBEAT_INTERVAL_MS }]);
      expect(sideChannel.listeners).toEqual(["error"]);
      expect(sideChannel.queries).toHaveLength(1);
      expect(sideChannel.queries[0]).toContain("INSERT INTO dropship.dropship_process_heartbeats");
      // Every statement and query is bounded below the beat's own timeout.
      const config = sideChannel.configs[0] as { statementTimeoutMs: number; queryTimeoutMs: number };
      expect(config.statementTimeoutMs).toBeLessThan(PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS);
      expect(config.queryTimeoutMs).toBeLessThan(PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS);
    } finally {
      handle.stop();
    }
  });

  it("adds no signal listener and never deletes its own row, also when stopped (CHK2)", async () => {
    const before = ["SIGTERM", "SIGINT", "beforeExit", "exit"].map((event) => process.listenerCount(event));
    const { timers, start, store } = harness(async () => undefined);
    const handle = await start();

    expect(["SIGTERM", "SIGINT", "beforeExit", "exit"].map((event) => process.listenerCount(event))).toEqual(before);
    handle.stop();
    handle.stop();
    expect(timers.intervals.every((entry) => entry.cleared)).toBe(true);
    expect(store.deleteStale).not.toHaveBeenCalled();
    // The store has no way to delete one process's row: the row only ages out.
    expect(Object.keys(store).sort()).toEqual(["beat", "deleteStale", "listOlderStillRunning"]);
  });

  it("once an hour deletes rows not seen for a day and raises the older-process ERROR (§3.1)", async () => {
    const { timers, start, store, logs } = harness(async () => undefined);
    await start();
    const hourly = timers.interval(PROCESS_HEARTBEAT_MAINTENANCE_INTERVAL_MS);

    hourly.callback();
    await flush();
    expect(store.deleteStale).toHaveBeenCalledWith({ olderThanMs: PROCESS_HEARTBEAT_RETENTION_MS });
    // PR C's processes (version 3) alert on an older process still reporting.
    expect(store.listOlderStillRunning).toHaveBeenCalledWith({ version: 3, graceMs: 120_000, alertAfterMs: 1_800_000 });
    expect(logs.some((entry) => entry.level === "error")).toBe(false);

    store.listOlderStillRunning.mockResolvedValueOnce([{
      processKey: "web.2:boot-old", catalogCodeVersion: 1, startedAt: new Date("2026-10-20T10:00:00.000Z"),
      lastSeenAt: new Date("2026-10-20T11:59:30.000Z"),
    }]);
    hourly.callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({
      level: "error", action: "dropship.release.older_process_still_running",
      data: expect.objectContaining({
        error_code: "DROPSHIP_RELEASE_OLDER_PROCESS_STILL_RUNNING",
        older_processes: [{ process_key: "web.2:boot-old", catalog_code_version: 1,
          started_at: "2026-10-20T10:00:00.000Z", last_seen_at: "2026-10-20T11:59:30.000Z" }],
      }),
    });

    store.deleteStale.mockRejectedValueOnce(new Error("timeout"));
    hourly.callback();
    await flush();
    expect(logs.at(-1)).toMatchObject({ level: "warn", action: "dropship.process_heartbeat.maintenance_failed" });
  });

  it("names the process by its dyno and boot id", () => {
    expect(dropshipProcessKey("web.1", "boot-a")).toBe("web.1:boot-a");
    expect(dropshipProcessKey(undefined, "boot-a")).toBe("local:boot-a");
    expect(dropshipProcessKey("  ", "boot-a")).toBe("local:boot-a");
  });
});

describe("process heartbeat SQL (one database clock, F30)", () => {
  function recorder() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; }) };
    return { calls, client };
  }

  it("writes the beat and its version's first-seen time in one statement, on the database clock", async () => {
    const { calls, client } = recorder();
    await writeProcessHeartbeat(client as never, { processKey: "web.1:boot-a", catalogCodeVersion: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(["web.1:boot-a", 1]);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(process_key\) DO UPDATE\s+SET last_seen_at = clock_timestamp\(\)/);
    expect(calls[0].sql).toMatch(/INSERT INTO dropship\.dropship_catalog_code_versions[\s\S]*ON CONFLICT \(catalog_code_version\) DO NOTHING/);
    // started_at is written once, at the first beat.
    expect(calls[0].sql).not.toMatch(/SET[^;]*started_at/);
    expect(calls[0].sql).not.toMatch(/\bnow\(\)/);
  });

  it("reads the grace, the settle and the alert on the database clock", async () => {
    const { calls, client } = recorder();
    await hasLiveOlderCatalogProcess(client as never, { belowVersion: 2, graceMs: 120_000 });
    await catalogVersionSettled(client as never, { version: 2, settleMs: 300_000 });
    await deleteStaleProcessHeartbeats(client as never, { olderThanMs: 86_400_000 });
    await listOlderProcessesStillRunning(client as never, { version: 2, graceMs: 120_000, alertAfterMs: 1_800_000 });

    expect(calls.map((call) => call.params)).toEqual([[2, 120_000], [2, 300_000], [86_400_000], [2, 120_000, 1_800_000]]);
    for (const call of calls) {
      expect(call.sql).toContain("clock_timestamp()");
      expect(call.sql).not.toMatch(/\bnow\(\)/);
    }
  });

  it("settles picks writes on this version or any later one, on the database clock (review SAV-1)", async () => {
    const { calls, client } = recorder();
    await catalogVersionAtLeastSettled(client as never, { minVersion: 2, settleMs: 300_000 });
    expect(calls.map((call) => call.params)).toEqual([[2, 300_000]]);
    expect(calls[0].sql).toMatch(/catalog_code_version >= \$1/);
    expect(calls[0].sql).toContain("clock_timestamp()");
  });
});

describe("server/index.ts starts the heartbeat first (§4.9 item 1, CHK2)", () => {
  const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");

  it("awaits it as the first statement of the listen callback, before any worker, outside every scheduler switch", () => {
    const callback = /httpServer\.listen\(\s*listenOptions,\s*async \(\) => \{\n([\s\S]*?)\n    \}\n  \);\n/.exec(index);
    expect(callback).not.toBeNull();
    const body = callback![1];
    const statements = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("//"));
    expect(statements[0]).toBe("await startDropshipProcessHeartbeatFromEnv();");
    const heartbeatAt = body.indexOf("await startDropshipProcessHeartbeatFromEnv();");
    const firstStart = body.search(/\bstart[A-Z][A-Za-z]*\((?!\))|\bstart[A-Z][A-Za-z]*Worker\(|initReconciliation\(/);
    expect(heartbeatAt).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeGreaterThan(heartbeatAt);
    // Not a scheduler: no schedulersDisabled() check comes before it.
    expect(body.slice(0, heartbeatAt)).not.toContain("schedulersDisabled");
    expect(index.match(/startDropshipProcessHeartbeatFromEnv\(\)/g)).toHaveLength(1);
  });
});
