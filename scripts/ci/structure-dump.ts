/**
 * Runs `pg_dump --schema-only` and returns the structure dump as text.
 * Shared by the schema drift check (scratch databases) and the job that
 * publishes production's structure (scripts/publish-production-structure.ts).
 */
import { spawnSync } from "node:child_process";
import { CheckError } from "./disposable-database";

const PG_DUMP_TIMEOUT_MS = 10 * 60_000;
const PG_DUMP_OUTPUT_LIMIT_BYTES = 512 * 1024 * 1024;
const PG_DUMP_ERROR_TAIL_LINES = 10;
/** libpq settings this module sets itself; inherited values must not leak into a dump. */
const LIBPQ_VARIABLES = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGOPTIONS", "PGSERVICE"];
const REDACTED = "<redacted>";
/** Shorter values are left alone: replacing them would shred ordinary words in the text. */
const REDACTION_MIN_LENGTH = 4;

/**
 * Environment variables that point pg_dump at a database. The password travels
 * in the environment, never on the command line, so it cannot appear in a
 * process listing or in a log of the command.
 */
export function libpqEnvironment(databaseUrl: URL, options: { production: boolean }): Record<string, string> {
  const database = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || databaseUrl.hostname === "" || database === "") {
    throw new CheckError("STRUCTURE_DUMP_DATABASE_URL_INVALID", "A database URL must be a PostgreSQL URL with a host and a database name.");
  }
  const environment: Record<string, string> = {
    PGHOST: databaseUrl.hostname,
    PGPORT: databaseUrl.port || "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
    PGDATABASE: database,
  };
  if (options.production) {
    environment.PGSSLMODE = "require";
    // A structure dump only reads. This makes the server refuse a write even
    // though the application's own credential could make one.
    environment.PGOPTIONS = "-c default_transaction_read_only=on";
  }
  return environment;
}

/** Replaces every occurrence of the given values in `text`, longest first. */
export function redactValues(text: string, values: ReadonlyArray<string | undefined>): string {
  const targets = values
    .filter((value): value is string => typeof value === "string" && value.length >= REDACTION_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  return targets.reduce((result, value) => result.split(value).join(REDACTED), text);
}

/**
 * Dumps the structure (no rows) of the database `environment` points at.
 * PG_DUMP_PATH names the pg_dump executable; it must be version 17 or newer,
 * because pg_dump refuses a server newer than itself.
 */
export function dumpStructure(environment: Record<string, string>, failureCode: string, env: NodeJS.ProcessEnv = process.env): string {
  const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => !LIBPQ_VARIABLES.includes(name)));
  const result = spawnSync(env.PG_DUMP_PATH || "pg_dump", ["--schema-only", "--no-owner", "--no-privileges"], {
    encoding: "utf8",
    timeout: PG_DUMP_TIMEOUT_MS,
    maxBuffer: PG_DUMP_OUTPUT_LIMIT_BYTES,
    env: { ...inherited, ...environment },
  });
  if (result.error || result.status !== 0) {
    // Connection errors name the host, user and database. Those identify the
    // server, so they are removed before the text reaches a log.
    const secrets = [environment.PGHOST, environment.PGUSER, environment.PGPASSWORD, environment.PGDATABASE];
    throw new CheckError(failureCode, "pg_dump could not dump a database structure.", {
      status: result.status,
      error: result.error ? redactValues(result.error.message, secrets) : null,
      stderr: redactValues(result.stderr ?? "", secrets).split("\n").filter(Boolean).slice(-PG_DUMP_ERROR_TAIL_LINES),
    });
  }
  return result.stdout;
}
