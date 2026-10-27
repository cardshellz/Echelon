import type pg from "pg";

interface SnapshotObservation {
  backendPid: number;
  isolation: string;
  readOnly: string;
}

function queryText(args: readonly unknown[]): string {
  const query = args[0];
  if (typeof query === "string") return query;
  if (typeof query === "object" && query !== null && "text" in query && typeof query.text === "string") return query.text;
  return "";
}

function isSummaryInvoiceRead(text: string): boolean {
  return text.startsWith("select ") && text.includes('from "procurement"."vendor_invoices"')
    && text.includes('"balance_cents"') && text.includes('"due_date"');
}

/** Pause delivery only after the actual first invoice query has completed.
 * Both the old pool path and the real transaction-client path are observed, so
 * a missing transaction fails the same race rather than skipping the barrier.
 * Actual Drizzle queries use Promise-based string/QueryConfig + parameter calls.
 * No query result, financial command, or transaction option is substituted. */
export function createApSummaryReadBarrier(modulePool: pg.Pool, options: { failAfterRead?: boolean } = {}) {
  const originalQuery = modulePool.query;
  const originalConnect = modulePool.connect;
  let notifyRead!: () => void;
  let resumeRead!: () => void;
  const readReached = new Promise<void>(resolve => { notifyRead = resolve; });
  const released = new Promise<void>(resolve => { resumeRead = resolve; });
  let firstLeaseClaimed = false;
  let paused = false;
  let observation: SnapshotObservation | undefined;
  let readerReleaseCount = 0;
  let directQueryAttempts = 0;
  let connectionAttempts = 0;
  const readerStatements: string[] = [];

  function instrumentQuery(target: pg.Pool | pg.PoolClient, query: pg.Pool["query"] | pg.PoolClient["query"], transactional: boolean) {
    return (...args: unknown[]): unknown => {
      const text = queryText(args);
      if (transactional) readerStatements.push(text); else directQueryAttempts += 1;
      const intercept = !paused && isSummaryInvoiceRead(text);
      // Callback delivery is not used by the actual Drizzle path under test.
      // Refuse an unexpected matching signature instead of silently missing it.
      if (intercept && typeof args.at(-1) === "function") throw new Error("AP summary barrier expected a Promise-based Drizzle query");
      const result = Reflect.apply(query, target, args);
      if (!intercept) return result;
      return Promise.resolve(result).then(async actual => {
        paused = true;
        // A legacy pool read has no pinned reader lease. Do not accidentally
        // capture the subsequent writer transaction as the summary's reader.
        firstLeaseClaimed = true;
        if (transactional) {
          const metadata = await Reflect.apply(query, target, [
            "SELECT pg_backend_pid()::int AS pid,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only",
          ]) as pg.QueryResult<{ pid: number; isolation: string; read_only: string }>;
          const row = metadata.rows[0];
          if (!row || !Number.isInteger(row.pid) || typeof row.isolation !== "string" || typeof row.read_only !== "string") {
            throw new Error("AP summary reader did not return its real transaction identity");
          }
          observation = { backendPid: row.pid, isolation: row.isolation, readOnly: row.read_only };
        }
        notifyRead();
        await released;
        if (options.failAfterRead) {
          // Real PostgreSQL failure on the same pinned reader connection. Its
          // transaction must roll back and release normally before a fresh read.
          await Reflect.apply(query, target, ["SELECT 1 / 0"]);
        }
        return actual;
      });
    };
  }

  modulePool.query = instrumentQuery(modulePool, originalQuery, false) as typeof modulePool.query;
  modulePool.connect = ((...args: unknown[]) => {
    connectionAttempts += 1;
    // The actual transaction owner leases without a callback. Preserve unrelated
    // callback connections, including their original synchronous return value.
    if (args.length) return Reflect.apply(originalConnect, modulePool, args);
    return (async () => {
      const claim = !firstLeaseClaimed;
      firstLeaseClaimed = true;
      const client = await Reflect.apply(originalConnect, modulePool, args) as pg.PoolClient;
      if (!claim) return client;
      const wrappedQuery = instrumentQuery(client, client.query, true);
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") return wrappedQuery;
          if (property === "release") return (...releaseArgs: unknown[]) => {
            readerReleaseCount += 1;
            return Reflect.apply(target.release, target, releaseArgs);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    })();
  }) as typeof modulePool.connect;

  return {
    async waitForRead(inFlight: Promise<unknown>): Promise<void> {
      await Promise.race([readReached, inFlight.then(() => { throw new Error("AP summary completed without its expected invoice-read barrier"); })]);
    },
    resume: resumeRead,
    get snapshot(): SnapshotObservation | undefined { return observation && { ...observation }; },
    get statements(): readonly string[] { return [...readerStatements]; },
    get readerReleaseCount(): number { return readerReleaseCount; },
    get transportAttempts() { return { directQueries: directQueryAttempts, connections: connectionAttempts }; },
    async close(inFlight: Promise<unknown>): Promise<void> {
      // A writer assertion can fail while the reader is paused. Always unblock
      // and settle that reader before restoring transport or dropping schemas.
      resumeRead();
      try { await inFlight.catch(() => undefined); }
      finally { modulePool.query = originalQuery; modulePool.connect = originalConnect; }
    },
  };
}