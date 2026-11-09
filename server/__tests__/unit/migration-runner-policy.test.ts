import { createHash } from "node:crypto";
import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Array<{ filename: string; content_hash: string | null }> }>>(),
  releaseClient: vi.fn(),
  connect: vi.fn(),
  end: vi.fn<() => Promise<void>>(),
  readFileSync: vi.fn<(path: string, encoding: string) => string>(),
  validateMigrationDirectory: vi.fn<(directory: string) => string[]>(),
  acquireLock: vi.fn<() => Promise<void>>(),
  releaseLock: vi.fn<() => Promise<void>>(),
  execute: vi.fn<(input: { file: string; sql: string; contentHash: string }) => Promise<{ attempts: number }>>(),
}));

vi.mock("pg", () => ({
  Pool: class {
    connect = doubles.connect;
    end = doubles.end;
  },
}));
vi.mock("fs", () => ({ readFileSync: doubles.readFileSync }));
vi.mock("../../../scripts/migrations/migration-policy.mjs", () => ({
  validateMigrationDirectory: doubles.validateMigrationDirectory,
}));
vi.mock("../../../migrations/migration-executor", () => ({
  acquireMigrationAdvisoryLock: doubles.acquireLock,
  releaseMigrationAdvisoryLock: doubles.releaseLock,
  executeMigrationWithRetry: doubles.execute,
  migrationRetryOptionsFromEnv: () => ({
    maxAttempts: 5, retryBaseDelayMs: 1000, retryMaxDelayMs: 15000, lockTimeoutMs: 15000,
  }),
  migrationErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  migrationSqlState: () => null,
}));

const firstFile = "900000001000017770001_first.sql";
const secondFile = "900000002000017780001_second.sql";
const firstSql = "CREATE TABLE first_migration (id integer);\n";
const secondSql = "CREATE TABLE second_migration (id integer);\n";
const sqlHash = (sql: string): string => createHash("sha256").update(sql).digest("hex");

describe("release migration runner policy boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/migration_runner_test");
    vi.stubEnv("EXTERNAL_DATABASE_URL", "");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The real entry point must request failure without terminating the test worker.
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    doubles.query.mockResolvedValue({ rows: [] });
    doubles.connect.mockResolvedValue({ query: doubles.query, release: doubles.releaseClient });
    doubles.end.mockResolvedValue(undefined);
    doubles.acquireLock.mockResolvedValue(undefined);
    doubles.releaseLock.mockResolvedValue(undefined);
    doubles.execute.mockResolvedValue({ attempts: 1 });
    doubles.validateMigrationDirectory.mockReturnValue([firstFile, secondFile]);
    doubles.readFileSync.mockImplementation((path) => {
      if (basename(path) === firstFile) return firstSql;
      if (basename(path) === secondFile) return secondSql;
      throw new Error(`Unexpected migration read: ${path}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function expectCleanup(): void {
    expect(doubles.acquireLock).toHaveBeenCalledOnce();
    expect(doubles.releaseLock).toHaveBeenCalledOnce();
    expect(doubles.releaseClient).toHaveBeenCalledOnce();
    expect(doubles.end).toHaveBeenCalledOnce();
  }

  it("rejects an invalid catalog before tracking or migration writes and cleans up the release connection", async () => {
    const rejection = new Error("Migration dependency metadata is missing");
    doubles.validateMigrationDirectory.mockImplementation(() => { throw rejection; });

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(doubles.query).not.toHaveBeenCalled();
    expect(doubles.readFileSync).not.toHaveBeenCalled();
    expect(doubles.execute).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Migration error:", rejection);
    expectCleanup();
  });

  it("executes pending migrations in the validated lexical order with their original SQL hashes", async () => {
    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(doubles.end).toHaveBeenCalledOnce());

    expect(doubles.execute.mock.calls.map(([input]) => ({
      file: input.file, sql: input.sql, contentHash: input.contentHash,
    }))).toEqual([
      { file: firstFile, sql: firstSql, contentHash: sqlHash(firstSql) },
      { file: secondFile, sql: secondSql, contentHash: sqlHash(secondSql) },
    ]);
    expect(process.exit).not.toHaveBeenCalled();
    expectCleanup();
  });

  it("does not reapply unchanged SQL adopted under a new filename when its historical hash is recorded", async () => {
    doubles.validateMigrationDirectory.mockReturnValue([firstFile]);
    doubles.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename, content_hash FROM _migrations"
        ? [{ filename: "0750_prior_name.sql", content_hash: sqlHash(firstSql) }]
        : [],
    }));

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(doubles.end).toHaveBeenCalledOnce());

    expect(doubles.readFileSync).toHaveBeenCalledOnce();
    expect(doubles.execute).not.toHaveBeenCalled();
    expect(doubles.query.mock.calls.some(([sql]) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toBe(false);
    expect(process.exit).not.toHaveBeenCalled();
    expectCleanup();
  });

  it("backfills content_hash when an already-applied migration has a null historical hash", async () => {
    doubles.validateMigrationDirectory.mockReturnValue([firstFile, secondFile]);
    doubles.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename, content_hash FROM _migrations"
        ? [{ filename: firstFile, content_hash: null }]
        : [],
    }));

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(doubles.end).toHaveBeenCalledOnce());

    expect(doubles.query).toHaveBeenCalledWith(
      "UPDATE _migrations SET content_hash = $1 WHERE filename = $2 AND (content_hash IS NULL OR content_hash = '')",
      [sqlHash(firstSql), firstFile],
    );
    expect(doubles.execute).toHaveBeenCalledOnce();
    expect(doubles.execute).toHaveBeenCalledWith(expect.objectContaining({
      file: secondFile,
      sql: secondSql,
      contentHash: sqlHash(secondSql),
    }));
    expect(process.exit).not.toHaveBeenCalled();
    expectCleanup();
  });

  it("fails the release without overwriting _migrations when an already-applied migration has a conflicting non-null hash (FC-MIG-02)", async () => {
    const conflictingHash = sqlHash("CREATE TABLE tampered_migration (id integer);\n");
    doubles.validateMigrationDirectory.mockReturnValue([firstFile, secondFile]);
    doubles.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename, content_hash FROM _migrations"
        ? [{ filename: firstFile, content_hash: conflictingHash }]
        : [],
    }));

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(doubles.execute).not.toHaveBeenCalled();
    expect(doubles.query.mock.calls.some(([sql]) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "Migration error:",
      expect.objectContaining({
        message: expect.stringContaining(
          `Refusing to overwrite conflicting migration hash for already-applied migration ${firstFile}`,
        ),
      }),
    );
    expectCleanup();
  });

  it("fails the release without overwriting _migrations when a renamed legacy migration has a conflicting non-null hash (FC-MIG-02)", async () => {
    const renamedFile = "0121_replen_task_method_and_autoreplen.sql";
    const legacyFile = "012_replen_task_method_and_autoreplen.sql";
    const conflictingHash = sqlHash("ALTER TABLE legacy_tampered ADD COLUMN x integer;\n");
    doubles.validateMigrationDirectory.mockReturnValue([renamedFile]);
    doubles.readFileSync.mockImplementation((path) => {
      if (basename(path) === renamedFile) return firstSql;
      throw new Error(`Unexpected migration read: ${path}`);
    });
    doubles.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename, content_hash FROM _migrations"
        ? [{ filename: legacyFile, content_hash: conflictingHash }]
        : [],
    }));

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(doubles.execute).not.toHaveBeenCalled();
    expect(doubles.query.mock.calls.some(([sql]) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "Migration error:",
      expect.objectContaining({
        message: expect.stringContaining(
          `Refusing to overwrite conflicting migration hash for renamed migration ${legacyFile} -> ${renamedFile}`,
        ),
      }),
    );
    expectCleanup();
  });

  it("refuses to run when EXTERNAL_DATABASE_URL and DATABASE_URL target different databases without leaking credentials (FC-MIG-03)", async () => {
    vi.stubEnv("EXTERNAL_DATABASE_URL", "postgresql://ext_user:super_secret_ext_pw@db-primary.internal:5432/echelon_prod");
    vi.stubEnv("DATABASE_URL", "postgresql://rel_user:super_secret_rel_pw@db-staging.internal:5432/echelon_staging");

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(doubles.connect).not.toHaveBeenCalled();
    expect(doubles.query).not.toHaveBeenCalled();
    expect(doubles.execute).not.toHaveBeenCalled();
    const loggedErrors = vi.mocked(console.error).mock.calls.flat().map(String).join(" ");
    expect(loggedErrors).toContain("target different databases");
    expect(loggedErrors).toContain("db-primary.internal:5432/echelon_prod");
    expect(loggedErrors).toContain("db-staging.internal:5432/echelon_staging");
    expect(loggedErrors).not.toContain("super_secret_ext_pw");
    expect(loggedErrors).not.toContain("super_secret_rel_pw");
  });

  it("destroys the pooled client connection if releasing the migration advisory lock fails", async () => {
    const unlockFailure = new Error("session advisory unlock failed");
    doubles.releaseLock.mockRejectedValueOnce(unlockFailure);

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(doubles.end).toHaveBeenCalledOnce());

    expect(doubles.releaseClient).toHaveBeenCalledWith(unlockFailure);
  });

  it("fails the release and stops before later migrations when execution rejects", async () => {
    const rejection = new Error("injected SQL execution failure");
    doubles.execute.mockRejectedValueOnce(rejection);

    await import("../../../migrations/run-migrations");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(doubles.execute).toHaveBeenCalledOnce();
    expect(doubles.execute).toHaveBeenCalledWith(expect.objectContaining({ file: firstFile, sql: firstSql }));
    expect(doubles.readFileSync).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("Migration error:", rejection);
    expectCleanup();
  });
});
