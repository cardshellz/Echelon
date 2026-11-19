/**
 * Helpers for CI checks that create and drop databases on a disposable local
 * PostgreSQL (the repository build check and the schema drift check).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MIGRATIONS_DIR = resolve(REPOSITORY_ROOT, "migrations");
export const ADMIN_STATEMENT_TIMEOUT_MS = 60_000;

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const RUNNER_TIMEOUT_MS = 5 * 60_000;
const RUNNER_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const RUNNER_FAILURE_TAIL_LINES = 40;

export class CheckError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The admin URL of the disposable server. Refuses anything that is not explicitly local and disposable. */
export function adminUrlFromEnv(env: NodeJS.ProcessEnv): URL {
  if (env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new CheckError("DATABASE_NOT_DISPOSABLE", "Set ECHELON_TEST_DATABASE_DISPOSABLE=true: this check creates and drops a database.");
  }
  let url: URL;
  try {
    url = new URL(env.ECHELON_TEST_DATABASE_URL ?? "");
  } catch {
    throw new CheckError("DATABASE_URL_INVALID", "ECHELON_TEST_DATABASE_URL must be an explicit local PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !LOCAL_HOSTS.includes(url.hostname)) {
    throw new CheckError("DATABASE_NOT_LOCAL", "This check only runs against PostgreSQL on localhost.");
  }
  return url;
}

export function localSslFromEnv(env: NodeJS.ProcessEnv): { rejectUnauthorized: false } | undefined {
  return env.MIGRATION_DATABASE_SSL === "disable" ? undefined : { rejectUnauthorized: false };
}

/** The same server as `adminUrl`, pointed at another database. */
export function databaseUrlOn(adminUrl: URL, databaseName: string): URL {
  const url = new URL(adminUrl.toString());
  url.pathname = `/${databaseName}`;
  return url;
}

/** Runs the release migration runner against `databaseUrl` and returns its output. */
export function runMigrationRunner(databaseUrl: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "migrations/run-migrations.ts"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: RUNNER_TIMEOUT_MS,
    maxBuffer: RUNNER_OUTPUT_LIMIT_BYTES,
    env: { ...env, DATABASE_URL: databaseUrl, EXTERNAL_DATABASE_URL: "" },
  });
  if (result.error || result.status !== 0) {
    throw new CheckError("MIGRATION_RUNNER_FAILED", "The migration runner failed against the new database.", {
      status: result.status,
      error: result.error?.message ?? null,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n")
        .filter((line) => !line.includes("already applied")).slice(-RUNNER_FAILURE_TAIL_LINES),
    });
  }
  return result.stdout ?? "";
}
