import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type pg from "pg";

export interface QueryMeasurement {
  fingerprint: string;
  sql: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  rows: number;
  failures: number;
}
export interface OwnerMeasurement<T> {
  label: string;
  elapsedMs: number;
  queries: number;
  queryElapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  peakSampledRssBytes: number;
  queryGroups: QueryMeasurement[];
  value: T;
}
interface Sample {
  deadline: number;
  groups: Map<string, QueryMeasurement>;
}
const installed = Symbol("procurementPerformanceQueryInstrumentation");

/** Counts actual driver queries, including queries through module-global DB
 * executors redirected by createFlowCostHarness. SQL parameters are not retained.
 * AsyncLocalStorage attributes parallel branches of one health read to that read.
 */
export function instrumentQueries(pool: pg.Pool) {
  const context = new AsyncLocalStorage<Sample>();
  const originals = new Map<pg.PoolClient, pg.PoolClient["query"]>();
  function acquire(client: pg.PoolClient): void {
    const instrumented = client as pg.PoolClient & { [installed]?: boolean };
    if (instrumented[installed]) return;
    const original = client.query;
    originals.set(client, original);
    instrumented[installed] = true;
    client.query = function (this: pg.PoolClient, ...args: unknown[]) {
      const sample = context.getStore();
      if (!sample) return Reflect.apply(original, this, args);
      const first = args[0];
      const queryText = typeof first === "string" ? first : (first as { text?: unknown } | null)?.text;
      if (typeof queryText !== "string") throw new Error("Performance instrument requires explicit SQL text");
      const normalized = queryText.trim().replace(/\s+/g, " ");
      if (performance.now() > sample.deadline && !/^rollback\b/i.test(normalized)) {
        throw new Error("PERFORMANCE_OWNER_TIME_BUDGET_EXCEEDED");
      }
      const fingerprint = createHash("sha256").update(normalized).digest("hex");
      const group = sample.groups.get(fingerprint) ?? {
        fingerprint, sql: normalized, calls: 0, totalMs: 0, maxMs: 0, rows: 0, failures: 0,
      };
      sample.groups.set(fingerprint, group);
      group.calls++;
      const started = performance.now();
      let complete = false;
      function finish(error: unknown, result?: { rowCount?: number | null }): void {
        if (complete) return;
        complete = true;
        const elapsed = performance.now() - started;
        group.totalMs += elapsed;
        group.maxMs = Math.max(group.maxMs, elapsed);
        group.rows += result?.rowCount ?? 0;
        if (error) group.failures++;
      }
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback === "function") {
        args[callbackIndex] = (error: unknown, result: { rowCount?: number | null }) => {
          finish(error, result);
          return Reflect.apply(callback, undefined, [error, result]);
        };
      }
      try {
        const result: unknown = Reflect.apply(original, this, args);
        if (result instanceof Promise) return result.then(
          value => { finish(null, value); return value; },
          error => { finish(error); throw error; },
        );
        return result;
      } catch (error) { finish(error); throw error; }
    } as pg.PoolClient["query"];
  }
  pool.on("acquire", acquire);
  return {
    async measure<T>(label: string, execute: () => Promise<T>, budgetMs = 60_000): Promise<OwnerMeasurement<T>> {
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 120_000) throw new Error("Invalid bounded performance budget");
      const started = performance.now();
      const sample: Sample = { deadline: started + budgetMs, groups: new Map() };
      const before = process.memoryUsage().rss;
      let peak = before;
      const interval = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
      try {
        const value = await context.run(sample, execute);
        const after = process.memoryUsage().rss;
        const groups = [...sample.groups.values()].sort((a, b) => b.totalMs - a.totalMs);
        return { label, elapsedMs: performance.now() - started,
          queries: groups.reduce((sum, group) => sum + group.calls, 0),
          queryElapsedMs: groups.reduce((sum, group) => sum + group.totalMs, 0),
          rssBeforeBytes: before, rssAfterBytes: after, peakSampledRssBytes: Math.max(peak, after), queryGroups: groups, value };
      } finally { clearInterval(interval); }
    },
    restore(): void {
      pool.off("acquire", acquire);
      for (const [client, query] of originals) {
        client.query = query;
        delete (client as pg.PoolClient & { [installed]?: boolean })[installed];
      }
    },
  };
}
