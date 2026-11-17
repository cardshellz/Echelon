/**
 * Proves that the repository alone can build an Echelon database.
 *
 * Creates a new, empty database on a disposable local PostgreSQL, runs the
 * release migration runner against it (schema baseline, then every migration
 * the baseline does not cover), and checks the result. It then runs the runner
 * a second time, which must change nothing.
 *
 * Requires PostgreSQL 17, the version production runs: the baseline is a
 * PostgreSQL 17 dump.
 *
 *   ECHELON_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
 *   ECHELON_TEST_DATABASE_DISPOSABLE=true MIGRATION_DATABASE_SSL=disable \
 *   node --import tsx scripts/ci/build-database-from-repository.ts
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateMigrationDirectory } from "../migrations/migration-policy.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIR = resolve(REPOSITORY_ROOT, "migrations");
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const RUNNER_TIMEOUT_MS = 5 * 60_000;
const ADMIN_STATEMENT_TIMEOUT_MS = 60_000;

class BuildCheckError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
  }
}

function adminUrlFromEnv(env: NodeJS.ProcessEnv): URL {
  if (env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new BuildCheckError("DATABASE_NOT_DISPOSABLE", "Set ECHELON_TEST_DATABASE_DISPOSABLE=true: this check creates and drops a database.");
  }
  let url: URL;
  try {
    url = new URL(env.ECHELON_TEST_DATABASE_URL ?? "");
  } catch {
    throw new BuildCheckError("DATABASE_URL_INVALID", "ECHELON_TEST_DATABASE_URL must be an explicit local PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !LOCAL_HOSTS.includes(url.hostname)) {
    throw new BuildCheckError("DATABASE_NOT_LOCAL", "This check only runs against PostgreSQL on localhost.");
  }
  return url;
}

function sslFromEnv(env: NodeJS.ProcessEnv): { rejectUnauthorized: false } | undefined {
  return env.MIGRATION_DATABASE_SSL === "disable" ? undefined : { rejectUnauthorized: false };
}

function runRunner(databaseUrl: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "migrations/run-migrations.ts"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: RUNNER_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, DATABASE_URL: databaseUrl, EXTERNAL_DATABASE_URL: "" },
  });
  if (result.error || result.status !== 0) {
    throw new BuildCheckError("MIGRATION_RUNNER_FAILED", "The migration runner failed against the new database.", {
      status: result.status,
      error: result.error?.message ?? null,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter((line) => !line.includes("already applied")).slice(-40),
    });
  }
  return result.stdout ?? "";
}

async function main(): Promise<void> {
  const adminUrl = adminUrlFromEnv(process.env);
  const ssl = sslFromEnv(process.env);
  const databaseName = `echelon_from_repository_${randomUUID().replace(/-/g, "")}`;
  const databaseUrl = new URL(adminUrl.toString());
  databaseUrl.pathname = `/${databaseName}`;
  const files = validateMigrationDirectory(MIGRATIONS_DIR);

  const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl, statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS });
  await admin.connect();
  try {
    // The name is generated above from hex digits only; identifiers cannot be bound as parameters.
    await admin.query(`CREATE DATABASE ${databaseName}`);
    try {
      const firstRun = runRunner(databaseUrl.toString(), process.env);
      if (!firstRun.includes('"action":"migration_baseline","outcome":"applied"')) {
        throw new BuildCheckError("BASELINE_NOT_APPLIED", "The runner did not load the schema baseline into the empty database.");
      }

      const built = new pg.Client({ connectionString: databaseUrl.toString(), ssl, statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS });
      await built.connect();
      let recorded: string[];
      let tableCount: number;
      try {
        recorded = (await built.query<{ filename: string }>(
          "SELECT filename FROM public._migrations WHERE content_hash IS NOT NULL",
        )).rows.map((row) => row.filename);
        tableCount = (await built.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        )).rows[0].count;
      } finally {
        await built.end();
      }
      const recordedSet = new Set(recorded);
      const unrecorded = files.filter((file) => !recordedSet.has(file));
      if (unrecorded.length > 0 || recorded.length !== files.length) {
        throw new BuildCheckError("MIGRATION_RECORDS_INCOMPLETE", "The built database does not record every repository migration exactly once.", {
          unrecorded, recorded: recorded.length, files: files.length,
        });
      }

      const secondRun = runRunner(databaseUrl.toString(), process.env);
      if (!secondRun.includes("Applied 0 new migration(s)") || secondRun.includes('"action":"migration_baseline"')) {
        throw new BuildCheckError("SECOND_RUN_NOT_IDLE", "Running the migrations again on the built database changed it.");
      }

      console.log(JSON.stringify({
        level: "info", action: "build_database_from_repository", outcome: "passed",
        migrations: files.length, tables: tableCount, error_code: null,
      }));
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  const failure = error instanceof BuildCheckError ? error : null;
  console.error(JSON.stringify({
    level: "error", action: "build_database_from_repository", outcome: "failed",
    error_code: failure?.code ?? "BUILD_CHECK_CRASHED",
    message: error instanceof Error ? error.message : String(error),
    context: failure?.context ?? {},
  }));
  process.exit(1);
});
