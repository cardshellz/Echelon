/** Local PostgreSQL execution tests. Cannot connect to a non-loopback server or reuse an existing database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg, { type Pool, type PoolClient, type QueryResult } from "pg";
import { CLEANUP_COMMAND, executeRecordsCleanup, RecordsCleanupError, type CleanupRequest } from "./inventory-cutover-records-execution-20260925";
import { readSchema, quote, seedFixture, snapshot, SCHEMA_FILE, SCHEMA_SHA } from "./inventory-cutover-records-rehearsal-fixture-20260925";

type Hook = (client: PoolClient, statement: string) => Promise<void>;
const checks: string[] = [];
let stage = "local_connection_guard";

// Faults exist only in this local runner. The production command has no fault flags,
// test callbacks, alternate query paths or commit bypasses.
function withQueryHooks(pool: Pool, hooks: { before?: Hook; after?: Hook }): Pick<Pool, "connect"> {
  return { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property === "query") return async (statement: string, values?: unknown[]): Promise<QueryResult> => {
        await hooks.before?.(target, statement);
        const result = await target.query(statement, values);
        await hooks.after?.(target, statement);
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as Pick<Pool, "connect">;
}

async function expectCode(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, error => error instanceof RecordsCleanupError && error.code === code,
    `Expected structured ${code}`);
}

async function main(): Promise<void> {
  const raw = process.env.ECHELON_RECORDS_REHEARSAL_ADMIN_URL;
  const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE;
  delete process.env.ECHELON_RECORDS_REHEARSAL_ADMIN_URL;
  delete process.env.DATABASE_URL;
  delete process.env.EXTERNAL_DATABASE_URL;
  assert.ok(raw && disposable === "1", "Explicit disposable loopback connection required");
  const url = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "127.0.0.1"
    && url.pathname === "/postgres" && !url.search && !url.hash, "Only local disposable PostgreSQL admin is accepted");
  const schema = readSchema();
  const admin = new pg.Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  const reports: unknown[] = [];

  async function inNewDatabase(work: (pool: Pool, request: CleanupRequest) => Promise<void>): Promise<void> {
    const database = `inventory_records_rehearsal_${randomUUID().replaceAll("-", "")}`;
    assert.match(database, /^inventory_records_rehearsal_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE ${quote(database)}`);
    const localUrl = new URL(raw!); localUrl.pathname = `/${database}`;
    const pool = new pg.Pool({ connectionString: localUrl.toString(), max: 4, connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=30000 -c lock_timeout=1500" });
    try {
      stage = "install_real_schema_and_synthetic_fixture";
      const client = await pool.connect();
      let fixture: Awaited<ReturnType<typeof seedFixture>>;
      try {
        assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, database);
        fixture = await seedFixture(client, schema);
      } finally { client.release(); }
      reports.push({ omittedForeignKeys: fixture.omittedForeignKeys, tableCounts: fixture.tableCounts });
      await work(pool, fixture.request);
    } finally {
      await pool.end();
      // Only the just-created, owned, randomly named database is removed. No file deletion or remote mode exists.
      await admin.query(`DROP DATABASE ${quote(database)}`);
    }
  }

  try {
    await inNewDatabase(async (pool, request) => {
      const reader = await pool.connect();
      try {
        const before = await snapshot(reader, schema.tables);
        async function rejection(label: string, code: string, input = request, hook?: Hook): Promise<void> {
          stage = label;
          await expectCode(() => executeRecordsCleanup(hook ? withQueryHooks(pool, { before: hook }) : pool, input), code);
          assert.deepEqual(await snapshot(reader, schema.tables), before, `${label} changed rows`);
          checks.push(label);
        }
        await rejection("wrong plan hash rejected without writes", "PLAN_HASH_MISMATCH", { ...request, expectedPlanHash: "0".repeat(64) });
        await rejection("malformed evidence rejected before connection", "INVALID_CLEANUP_EVIDENCE", { ...request, context: {} });
        await rejection("blank actor rejected", "INVALID_CLEANUP_EVIDENCE", { ...request, actor: " " });
        await rejection("changed authority revision rejected", "AUTHORITY_CHANGED", { ...request, expectedAuthorityRevision: "2" });
        await rejection("changed trigger fingerprint rejected", "DATABASE_TRIGGERS_CHANGED", { ...request, expectedTriggerHash: "0".repeat(64) });
        await rejection("stale reviewed line rolls back incidental outbox changes", "PROTECTED_ROWS_CHANGED", request,
          async (client, sql) => { if (sql.startsWith("SET LOCAL statement_timeout")) {
            await client.query("UPDATE oms.oms_order_lines SET sku='STALE-FIXTURE' WHERE id=4540");
          } });
        await rejection("new sibling invalidates complete-order proof", "PROTECTED_ROWS_CHANGED", request,
          async (client, sql) => { if (sql.startsWith("SET LOCAL statement_timeout")) {
            await client.query(`INSERT INTO oms.oms_order_lines(order_id,quantity,external_line_item_id,inventory_tracking)
              SELECT order_id,1,'new-unreviewed-line',false FROM oms.oms_order_lines WHERE id=4540`);
          } });
        await rejection("late database failure rolls back records audits refunds and internal outbox", "CLEANUP_TRANSACTION_FAILED", request,
          async (client, sql) => { if (sql === "SET CONSTRAINTS ALL IMMEDIATE") await client.query("SELECT 1/0"); });
        await rejection("unexpected reservation write rolls back the entire batch", "PROTECTED_ROWS_CHANGED", request,
          async (client, sql) => { if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
            await client.query("UPDATE inventory.inventory_levels SET reserved_qty=reserved_qty+1 WHERE id=1");
          } });
        await rejection("mutation of old audit evidence rolls back the entire batch", "AUDIT_OR_REFUND_HISTORY_CHANGED", request,
          async (client, sql) => { if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
            await client.query("UPDATE oms.oms_order_events SET details='{}'::jsonb WHERE event_type='rehearsal_prior_history'");
          } });
        await rejection("mutation of a non-lifecycle line column rolls back", "PROTECTED_ROWS_CHANGED", request,
          async (client, sql) => { if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
            await client.query("UPDATE oms.oms_order_lines SET sku='BAD-SIDE-EFFECT' WHERE id=4540");
          } });
        const lockHolder = await pool.connect();
        try {
          await lockHolder.query("BEGIN");
          await lockHolder.query("SELECT epoch FROM inventory.cutover_admission_fence FOR UPDATE");
          await rejection("activation fence prevents cleanup before order locks", "CLEANUP_TRANSACTION_FAILED");
          await lockHolder.query("ROLLBACK");
          await lockHolder.query("BEGIN");
          await lockHolder.query("SELECT id FROM oms.oms_order_lines WHERE id=4540 FOR UPDATE");
          await rejection("concurrent line writer prevents stale cleanup", "CLEANUP_TRANSACTION_FAILED");
        } finally { await lockHolder.query("ROLLBACK"); lockHolder.release(); }

        stage = "real_concurrent_execution";
        let releaseFirst!: () => void;
        let firstLocked!: () => void;
        const paused = new Promise<void>(resolve => { firstLocked = resolve; });
        const resume = new Promise<void>(resolve => { releaseFirst = resolve; });
        const first = executeRecordsCleanup(withQueryHooks(pool, { after: async (_client, sql) => {
          if (sql.startsWith("SELECT id FROM oms.oms_orders")) { firstLocked(); await resume; }
        } }), request);
        try {
          await Promise.race([paused, first.then(() => { throw new Error("First correction did not pause"); })]);
          await expectCode(() => executeRecordsCleanup(pool, request), "CLEANUP_ALREADY_RUNNING");
        } finally { releaseFirst(); }
        const result = await first;
        assert.deepEqual(result, { command: CLEANUP_COMMAND, replayed: false, lineUpdates: 24, orderUpdates: 29,
          refundEvidenceInserts: 4, authorityAuditInserts: 6, orderAuditInserts: 29, inventoryWrites: 0, providerRequests: 0 });
        checks.push("concurrent duplicate rejected while first exact batch commits successfully");
        const after = await snapshot(reader, schema.tables);
        const writable = new Set(["oms.oms_orders", "oms.oms_order_lines", "oms.order_line_adjustments", "oms.oms_order_events",
          "oms.oms_order_line_authority_events", "oms.archon_order_outbox", "oms.channel_order_intakes"]);
        for (const table of schema.tables) if (!writable.has(table)) assert.equal(after[table], before[table], table);
        checks.push("all protected fixture tables remain byte-equivalent including stock reservations shipping costs and provider commands");
        const context = request.context as { lines: Array<{ id: string; order_id: string; row_hash: string }>; approvedClosedLineIds: string[] };
        const protectedLines = context.lines.filter(line => !context.approvedClosedLineIds.includes(line.id));
        assert.equal(protectedLines.length, 15);
        assert.equal(protectedLines.filter(line => line.order_id === "963240").length, 9);
        for (const line of protectedLines) {
          assert.equal((await reader.query(`SELECT encode(sha256(convert_to(to_jsonb(row)::text,'UTF8')),'hex') AS hash
            FROM oms.oms_order_lines row WHERE id=$1`, [line.id])).rows[0].hash, line.row_hash);
        }
        checks.push("all fifteen other lines preserved including nine live-order lines");
        const outbox = (await reader.query("SELECT order_id FROM oms.archon_order_outbox ORDER BY order_id")).rows;
        assert.equal(outbox.length, 29);
        assert.ok(outbox.every(row => row.order_id !== 963240));
        const refreshed = (await reader.query("SELECT count(*)::int AS count FROM oms.channel_order_intakes WHERE is_shippable=true")).rows[0].count;
        assert.ok(refreshed > 0);
        checks.push("real OMS triggers queue twenty-nine internal order projections and refresh intake without live-order enrollment");
        const replay = await executeRecordsCleanup(pool, request);
        assert.deepEqual(replay, { ...result, replayed: true, lineUpdates: 0, orderUpdates: 0, refundEvidenceInserts: 0,
          authorityAuditInserts: 0, orderAuditInserts: 0 });
        assert.deepEqual(await snapshot(reader, schema.tables), after);
        checks.push("same-request retry performs zero writes including audits and internal outbox");
        await expectCode(() => executeRecordsCleanup(pool, { ...request, reason: "Different request cannot reuse an existing cleanup command" }), "REPLAY_COMMAND_CONFLICT");
        assert.deepEqual(await snapshot(reader, schema.tables), after);
        checks.push("conflicting retry metadata rejected without writes");
        await expectCode(() => executeRecordsCleanup(withQueryHooks(pool, { before: async (client, sql) => {
          if (sql.startsWith("SET LOCAL statement_timeout")) await client.query(
            "DELETE FROM oms.oms_order_line_authority_events WHERE event_key=$1", [`${CLEANUP_COMMAND}:line:4540`]);
        } }), request), "AUTHORITY_AUDIT_CHANGED");
        assert.deepEqual(await snapshot(reader, schema.tables), after);
        checks.push("retry detects missing authority audit rather than claiming a successful no-op");
        reports.push({ result, outboxRows: outbox.length, refreshedIntakes: refreshed, protectedLines: protectedLines.length });
      } finally { reader.release(); }
    });

    await inNewDatabase(async (pool, request) => {
      stage = "uncertain_first_commit";
      await expectCode(() => executeRecordsCleanup(withQueryHooks(pool, { after: async (_client, sql) => {
        if (sql === "COMMIT") throw new Error("Injected lost acknowledgment after actual server commit");
      } }), request), "COMMIT_RESULT_UNCERTAIN");
      const reader = await pool.connect();
      try {
        const committed = await snapshot(reader, schema.tables);
        const replay = await executeRecordsCleanup(pool, request);
        assert.equal(replay.replayed, true); assert.equal(replay.lineUpdates, 0);
        assert.deepEqual(await snapshot(reader, schema.tables), committed);
        assert.equal((await reader.query("SELECT count(*)::int AS count FROM oms.oms_order_events WHERE event_type='cutover_records_corrected'")).rows[0].count, 29);
        checks.push("lost acknowledgment after real first commit recovers through verified zero-write retry");
      } finally { reader.release(); }
    });
    stage = "write_rehearsal_report";
    const directory = resolve("artifacts/inventory-cutover-20260924");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, `records-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ productionWrites: false, providerRequests: 0, schemaFile: SCHEMA_FILE, schemaSha256: SCHEMA_SHA,
      triggerHash: schema.triggerHash, checks, reports, limitations: [
        "Private and cost fields are synthetic; operational target IDs, quantities and lifecycle values follow the pinned read-only context.",
        "Foreign keys to unrelated tables are omitted and listed. Existing scoped foreign keys are NOT VALID but enforce new/changed references.",
        "Real triggers on seven written or internally synchronized tables are installed; untouched-table trigger dependencies are not reproduced.",
        "Nontransactional sequence gaps on rollback are expected and are not inventory/audit rows.",
        "No provider API, delivery worker, whole-opening assessment or production cleanup was run.",
      ] }, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ file, checks: checks.length, productionWrites: false, disposableDatabasesRemoved: 2 }));
  } finally { await admin.end(); }
}

main().catch(error => {
  console.error(JSON.stringify({ stage, code: error instanceof RecordsCleanupError ? error.code : "LOCAL_REHEARSAL_FAILED",
    message: error instanceof Error ? error.message : "Unknown local test failure", productionWrites: false }));
  process.exitCode = 1;
});
