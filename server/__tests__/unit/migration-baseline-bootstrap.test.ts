import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BaselineBootstrapError,
  applyBaselineToEmptyDatabase,
} from "../../../migrations/baseline-bootstrap";
import type { MigrationQueryClient } from "../../../migrations/migration-executor";
import { baselineSha256 } from "../../../scripts/migrations/baseline-format.mjs";

const MIGRATIONS_DIR = join("repo", "migrations");
const SCHEMA_SQL = "SET LOCAL statement_timeout = 0;\nCREATE TABLE public._migrations (id integer);\n";
const FIRST = "0001_first.sql";
const SECOND = "900000001000017770001_second.sql";
const LATER = "900000002000017780001_after_baseline.sql";
const MIGRATION_SQL: Record<string, string> = {
  [FIRST]: "CREATE TABLE first (id integer);\r\n",
  [SECOND]: "CREATE TABLE second (id integer);\n",
};
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    capturedAt: "2026-11-17",
    serverVersion: "17.10",
    schemaSha256: baselineSha256(SCHEMA_SQL),
    covers: [FIRST, SECOND],
    ...overrides,
  });
}

function readFileFrom(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error(`Unexpected read: ${path}`);
    return content;
  };
}

function repositoryFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [join(MIGRATIONS_DIR, "baseline", "manifest.json")]: manifestJson(),
    [join(MIGRATIONS_DIR, "baseline", "schema.sql")]: SCHEMA_SQL,
    [join(MIGRATIONS_DIR, FIRST)]: MIGRATION_SQL[FIRST],
    [join(MIGRATIONS_DIR, SECOND)]: MIGRATION_SQL[SECOND],
    ...overrides,
  };
}

type State = { has_migration_records: unknown; relation_count: unknown; schema_count: unknown };
const EMPTY: State = { has_migration_records: false, relation_count: 0, schema_count: 0 };

function clientWith(state: State | undefined, failOn?: (sql: string) => Error | undefined) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    const failure = failOn?.(sql);
    if (failure) throw failure;
    return sql.includes("has_migration_records") ? { rows: state ? [state] : [] } : { rows: [] };
  });
  // Everything after the state query: what the bootstrap wrote, if anything.
  const writes = () => statements.slice(1).map((statement) => statement.sql.trim());
  return { client: { query }, statements, writes };
}

const input = (client: MigrationQueryClient, files = repositoryFiles()) => ({
  client,
  migrationsDir: MIGRATIONS_DIR,
  files: [FIRST, SECOND, LATER],
  readFile: readFileFrom(files),
});

describe("schema baseline bootstrap", () => {
  it("does nothing to a database that already has migration records", async () => {
    // Production: thousands of objects and a populated _migrations table.
    const { client, writes } = clientWith({ has_migration_records: true, relation_count: 4000, schema_count: 20 });
    const readFile = vi.fn(() => { throw new Error("must not read the baseline"); });

    await expect(applyBaselineToEmptyDatabase({ ...input(client), readFile }))
      .resolves.toEqual({ applied: false, reason: "database_has_migration_records" });
    expect(writes()).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("loads the baseline into an empty database and records every covered migration, in one transaction", async () => {
    const { client, statements, writes } = clientWith(EMPTY);

    await expect(applyBaselineToEmptyDatabase(input(client)))
      .resolves.toEqual({ applied: true, recorded: 2, capturedAt: "2026-11-17" });

    expect(writes()[0]).toBe("BEGIN");
    expect(writes()[1]).toBe(SCHEMA_SQL.trim());
    expect(writes()[2]).toContain("INSERT INTO public._migrations (filename, content_hash)");
    expect(writes()[3]).toBe("COMMIT");
    expect(writes()).toHaveLength(4);
    // Hashes are of the files exactly as the runner reads them (no line-ending
    // normalization), so its later already-applied check agrees.
    expect(statements[3].values).toEqual([
      [FIRST, SECOND],
      [sha256(MIGRATION_SQL[FIRST]), sha256(MIGRATION_SQL[SECOND])],
    ]);
  });

  it("does not record migrations the baseline does not cover", async () => {
    const { client, statements } = clientWith(EMPTY);
    await applyBaselineToEmptyDatabase(input(client));
    expect((statements[3].values as string[][])[0]).not.toContain(LATER);
  });

  it.each([
    ["tables but no migration records", { has_migration_records: false, relation_count: 3, schema_count: 0 }],
    ["schemas but no migration records", { has_migration_records: false, relation_count: 0, schema_count: 1 }],
  ])("refuses a database with %s", async (_label, state) => {
    const { client, writes } = clientWith(state);
    await expect(applyBaselineToEmptyDatabase(input(client))).rejects.toMatchObject({
      name: "BaselineBootstrapError",
      code: "MIGRATION_BASELINE_DATABASE_NOT_EMPTY",
      context: { relationCount: state.relation_count, schemaCount: state.schema_count },
    });
    expect(writes()).toEqual([]);
  });

  it.each([
    ["no row", undefined],
    ["a non-boolean flag", { has_migration_records: "f", relation_count: 0, schema_count: 0 }],
    ["a non-integer count", { has_migration_records: false, relation_count: "0", schema_count: 0 }],
    ["a missing count", { has_migration_records: false, relation_count: 0, schema_count: undefined }],
  ])("fails closed when the database state query returns %s", async (_label, state) => {
    const { client, writes } = clientWith(state as State | undefined);
    await expect(applyBaselineToEmptyDatabase(input(client))).rejects.toMatchObject({
      code: "MIGRATION_BASELINE_STATE_UNREADABLE",
    });
    expect(writes()).toEqual([]);
  });

  it("refuses a schema file that does not match its manifest", async () => {
    const { client, writes } = clientWith(EMPTY);
    const files = repositoryFiles({ [join(MIGRATIONS_DIR, "baseline", "schema.sql")]: `${SCHEMA_SQL}DROP TABLE x;\n` });
    await expect(applyBaselineToEmptyDatabase(input(client, files))).rejects.toMatchObject({
      code: "MIGRATION_BASELINE_HASH_MISMATCH",
      context: { expected: baselineSha256(SCHEMA_SQL) },
    });
    expect(writes()).toEqual([]);
  });

  it("accepts a schema file checked out with CRLF line endings", async () => {
    const { client } = clientWith(EMPTY);
    const files = repositoryFiles({ [join(MIGRATIONS_DIR, "baseline", "schema.sql")]: SCHEMA_SQL.replace(/\n/g, "\r\n") });
    await expect(applyBaselineToEmptyDatabase(input(client, files))).resolves.toMatchObject({ applied: true });
  });

  it("refuses a manifest that covers a migration missing from the repository", async () => {
    const { client, writes } = clientWith(EMPTY);
    await expect(applyBaselineToEmptyDatabase({ ...input(client), files: [FIRST, LATER] })).rejects.toMatchObject({
      code: "MIGRATION_BASELINE_COVERS_MISSING_FILE",
      context: { missing: [SECOND] },
    });
    expect(writes()).toEqual([]);
  });

  it("rejects a malformed manifest before touching the database", async () => {
    const { client, writes } = clientWith(EMPTY);
    const files = repositoryFiles({ [join(MIGRATIONS_DIR, "baseline", "manifest.json")]: manifestJson({ covers: [] }) });
    await expect(applyBaselineToEmptyDatabase(input(client, files))).rejects.toMatchObject({ code: "INVALID_BASELINE_MANIFEST" });
    expect(writes()).toEqual([]);
  });

  it("rolls back and rethrows when the schema fails to load", async () => {
    const failure = new Error("syntax error at or near CREATE");
    const { client, writes } = clientWith(EMPTY, (sql) => (sql === SCHEMA_SQL ? failure : undefined));
    await expect(applyBaselineToEmptyDatabase(input(client))).rejects.toBe(failure);
    expect(writes()).toEqual(["BEGIN", SCHEMA_SQL.trim(), "ROLLBACK"]);
  });

  it("rolls back when recording the covered migrations fails, leaving the database empty", async () => {
    const failure = new Error("duplicate key value");
    const { client, writes } = clientWith(EMPTY, (sql) => (sql.includes("INSERT INTO public._migrations") ? failure : undefined));
    await expect(applyBaselineToEmptyDatabase(input(client))).rejects.toBe(failure);
    expect(writes().at(-1)).toBe("ROLLBACK");
    expect(writes()).not.toContain("COMMIT");
  });

  it("reports both errors when the rollback itself fails", async () => {
    const failure = new Error("schema failed");
    const rollbackFailure = new Error("connection lost");
    const { client } = clientWith(EMPTY, (sql) => (sql === SCHEMA_SQL ? failure : sql === "ROLLBACK" ? rollbackFailure : undefined));
    const rejection = await applyBaselineToEmptyDatabase(input(client)).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([failure, rollbackFailure]);
  });

  it("classifies its own failures with a namespaced code", () => {
    const error = new BaselineBootstrapError("MIGRATION_BASELINE_DATABASE_NOT_EMPTY", "x", { relationCount: 1 });
    expect(error).toMatchObject({ code: "MIGRATION_BASELINE_DATABASE_NOT_EMPTY", context: { relationCount: 1 } });
  });
});
